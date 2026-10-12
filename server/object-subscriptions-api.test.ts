import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp } from './app.ts';
import { createAuth } from './auth.ts';
import { Store } from './store.ts';
import { objectSubscriptionInput, type ObjectSubscriptionInput, type ObjectSubscriptionSnapshot, type ObjectSubscriptionReceipt, type ObjectSubscriptionHistory, type ObjectMuteHistory, type ObjectSubscriptionPerson } from '../shared/object-subscriptions.ts';
import type { NotificationInbox, NotificationSummary } from '../shared/notifications.ts';

const members = (...principalIds: string[]) => ({ kind: 'principals' as const, principalIds }), workspace = { kind: 'workspace' as const };
async function start(basePath = '/') {
  const store = new Store({ path: ':memory:' });
  const provision = createAuth({ database: store.database, mode: 'local', basePath, provisioning: true });
  const alice = await provision.createAccount({ username: 'alice', displayName: 'Alice', password: 'Alice object subscription password' });
  const bob = await provision.createAccount({ username: 'bob', displayName: 'Bob', password: 'Bob object subscription password' });
  const carol = await provision.createAccount({ username: 'carol', displayName: 'Carol', password: 'Carol object subscription password' });
  const app = createApp({ store, seed: false, authMode: 'password', basePath });
  const tokens = { alice: app.auth.createToken(alice.id, { name: 'Author', scopes: ['read', 'write'] }), bob: app.auth.createToken(bob.id, { name: 'Editor', scopes: ['read', 'write'] }), carol: app.auth.createToken(carol.id, { name: 'Follower', scopes: ['read', 'write'] }), reader: app.auth.createToken(carol.id, { name: 'Reader', scopes: ['read'] }) };
  const actor = { principalId: alice.id, displayName: alice.displayName, credentialId: tokens.alice.record.id, requestId: 'source-fixture' };
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}${basePath.replace(/\/$/, '')}`;
  async function request<T = { error: string; code?: string }>(path: string, method = 'GET', body?: unknown, who: keyof typeof tokens = 'alice', key?: string) {
    const response = await fetch(origin + path, { method, signal: AbortSignal.timeout(30_000), headers: { Authorization: `Bearer ${tokens[who].token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as T, headers: response.headers };
  }
  const path = (id: string) => `/api/objects/${id}/subscriptions`;
  const policy = (id: string, rules: Record<string, unknown>) => { const current = app.policies.policy(id, alice.id); return app.policies.setPolicy(id, { expectedVersion: current.version, spaceId: current.spaceId, ...current.rules, ...rules }, alice.id); };
  const source = (kind: 'wiki' | 'paste') => {
    const id = kind === 'wiki' ? store.createDocument({ slug: '/', title: 'Wiki source', content: 'Exact unpublished-safe manuscript\n' }, actor).id : store.pastes.create({ title: 'Paste source', content: 'Exact manuscript\n' }, actor).id;
    policy(id, { view: workspace, edit: members(alice.id, bob.id), interact: workspace }); return id;
  };
  const input = (id: string, action: ObjectSubscriptionInput['action'], principalId = carol.id): ObjectSubscriptionInput => {
    const snapshot = store.objectSubscriptions.snapshot(id, principalId);
    return objectSubscriptionInput({ action, principalId, expectedAccessEpoch: app.policies.epoch(), ...(['subscribe', 'unsubscribe'].includes(action) ? { expectedSubscriptionVersion: snapshot.viewer.version } : { expectedMuteVersion: snapshot.mute.version }) });
  };
  const act = async (id: string, action: ObjectSubscriptionInput['action'], who: keyof typeof tokens = 'carol', principalId = tokens[who].record.accountId, key: string = randomUUID()) => {
    const data = input(id, action, principalId), result = await request<ObjectSubscriptionReceipt>(path(id), 'POST', data, who, key); assert.equal(result.status, 200, JSON.stringify(result.body)); return { data, key, receipt: result.body };
  };
  const summary = async (who: keyof typeof tokens = 'carol') => { const result = await request<NotificationSummary>('/api/notifications/count', 'GET', undefined, who); assert.equal(result.status, 200); return result.body; };
  return { ...app, alice, bob, carol, actor, tokens, request, path, policy, source, input, act, summary, close: async () => { await app.close(); store.close(); } };
}

for (const basePath of ['/', '/mounted/']) test(`Wiki and Paste following preserve sources, private mute and exact old receipts at ${basePath}`, async () => {
  const app = await start(basePath);
  try {
    for (const kind of ['wiki', 'paste'] as const) {
      const id = app.source(kind); app.policy(id, { edit: members(app.alice.id), interact: members(app.alice.id) });
      const source = () => kind === 'wiki' ? app.store.documentDetail(id) : app.store.pastes.detail(id);
      const before = source(), first = await app.request<ObjectSubscriptionSnapshot>(app.path(id), 'GET', undefined, 'reader');
      assert.equal(first.status, 200); assert.equal(first.headers.get('cache-control'), 'no-store'); assert.equal(first.body.access.capabilities.edit, false); assert.equal(first.body.access.capabilities.interact, false);
      assert.equal((await app.request(app.path(id), 'POST', app.input(id, 'subscribe'), 'reader', 'scope-denied-' + kind)).status, 403);
      const followed = await app.act(id, 'subscribe'), noOp = await app.act(id, 'subscribe'), muted = await app.act(id, 'mute');
      assert.equal(followed.receipt.changed, true); assert.equal(noOp.receipt.changed, false); assert.equal(noOp.receipt.transaction, null);
      await app.act(id, 'unsubscribe'); await app.act(id, 'unmute');
      for (const saved of [followed, noOp, muted]) { const replay = await app.request(app.path(id), 'POST', saved.data, 'carol', saved.key); assert.equal(replay.status, 200); assert.deepEqual(replay.body, saved.receipt); }
      assert.deepEqual(source(), before); assert.equal((await app.summary()).unreadCount, 0, 'personal preference changes are quiet');
      const author = app.store.objectSubscriptions.status(id, app.alice.id); assert.deepEqual(author.automatic, kind === 'wiki' ? [] : ['author']); assert.equal(author.following, kind === 'paste');
      if (kind === 'paste') for (const action of ['subscribe', 'unsubscribe'] as const) assert.equal((await app.request(app.path(id), 'POST', app.input(id, action, app.alice.id), 'alice', action)).status, 409);
    }
  } finally { await app.close(); }
});

test('Wiki/Paste people permissions, private history, recipient opt-outs and disabled member removal', async () => {
  const app = await start();
  try {
    for (const kind of ['wiki', 'paste'] as const) {
      const id = app.source(kind); app.policy(id, { edit: members(app.alice.id, app.bob.id), interact: members(app.carol.id) });
      await app.act(id, 'subscribe', 'carol', app.bob.id);
      assert.equal((await app.request(app.path(id), 'POST', app.input(id, 'unsubscribe', app.bob.id), 'carol', 'remove-' + kind)).status, 403);
      await app.act(id, 'subscribe', 'bob', app.carol.id);
      assert.equal((await app.request(app.path(id), 'POST', app.input(id, 'mute', app.bob.id), 'carol', 'foreign-mute-' + kind)).status, 403);
      const publicState = async () => ({ snapshot: (await app.request(app.path(id), 'GET', undefined, 'bob')).body, history: (await app.request(app.path(id) + '/history', 'GET', undefined, 'bob')).body, person: (await app.request(app.path(id) + '/person?principalId=' + app.carol.id, 'GET', undefined, 'bob')).body });
      const before = await publicState(); await app.act(id, 'mute'); assert.deepEqual(await publicState(), before);
      const mine = (await app.request<ObjectMuteHistory>(app.path(id) + '/mute-history', 'GET', undefined, 'carol')).body, other = (await app.request<ObjectMuteHistory>(app.path(id) + '/mute-history', 'GET', undefined, 'bob')).body;
      assert.equal(mine.principalId, app.carol.id); assert.equal(mine.transactions.length, 1); assert.equal(other.transactions.length, 0);
      for (const suffix of ['?principalId=' + app.carol.id, '/history?principalId=' + app.carol.id, '/mute-history?principalId=' + app.carol.id]) assert.equal((await app.request(app.path(id) + suffix)).status, 400);
      app.auth.setAccountDisabled(app.carol.id, true); await app.act(id, 'unsubscribe', 'bob', app.carol.id);
      assert.equal((await app.request(app.path(id), 'POST', app.input(id, 'subscribe'), 'bob', 'disabled-add-' + kind)).status, 400);
      app.auth.setAccountDisabled(app.carol.id, false); app.tokens.carol = app.auth.createToken(app.carol.id, { name: 'Reenabled follower', scopes: ['read', 'write'] });
      const found = await app.request<ObjectSubscriptionPerson>(app.path(id) + '/person?principalId=' + app.carol.id, 'GET', undefined, 'bob'); assert.equal(found.body.status.state, 'unsubscribed'); assert.equal('mute' in found.body, false);
    }
  } finally { await app.close(); }
});

test('Wiki/Paste subscription pagination, source independence and concurrent writes use exact preference pins', async () => {
  const app = await start();
  try {
    for (const kind of ['wiki', 'paste'] as const) {
      const id = app.source(kind); await app.act(id, 'subscribe'); await app.act(id, 'unsubscribe'); await app.act(id, 'subscribe', 'bob');
      const inspected = app.input(id, 'subscribe');
      if (kind === 'paste') app.store.pastes.update(id, { expectedVersion: 1, content: 'Changed exact source' }, app.actor);
      else { const doc = app.store.documentDetail(id); app.store.updateDocument(id, { expectedVersion: doc.document.version, slug: doc.document.slug, title: doc.document.title, content: 'Changed exact source' }, app.actor); }
      assert.equal((await app.request(app.path(id), 'POST', inspected, 'carol', 'source-independent-' + kind)).status, 200);
      const current = (await app.request<ObjectSubscriptionSnapshot>(app.path(id))).body;
      const query = `?limit=1&expectedSubscriptionVersion=${current.subscriptionVersion}`;
      const first = (await app.request<ObjectSubscriptionSnapshot>(app.path(id) + query)).body; assert.equal(first.subscribers.length, 1); assert.ok(first.nextAfter);
      const next = (await app.request<ObjectSubscriptionSnapshot>(app.path(id) + query + '&after=' + encodeURIComponent(first.nextAfter!))).body; assert.equal(next.subscribers.length, 1); assert.notEqual(first.subscribers[0]!.principalId, next.subscribers[0]!.principalId);
      const history = (await app.request<ObjectSubscriptionHistory>(app.path(id) + '/history?limit=1')).body; assert.equal(history.transactions.length, 1); assert.ok(history.nextBefore);
      const race = app.input(id, 'unsubscribe'), responses = await Promise.all(['first', 'second'].map(key => app.request(app.path(id), 'POST', race, 'carol', key + kind))); assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
      assert.equal((await app.request(app.path(id) + query)).status, 409);
      for (const suffix of ['?extra=1', '?limit=101', '?limit=1&limit=2', '?after=', '/history?before=0', '/mute-history?expectedMuteVersion=-1', '/person', '/person?principalId=a&principalId=b']) assert.equal((await app.request(app.path(id) + suffix)).status, 400, suffix);
      assert.equal((await app.request(app.path(id), 'POST', app.input(id, 'subscribe'), 'carol')).status, 400);
      assert.equal((await app.request(app.path(id), 'POST', { ...app.input(id, 'subscribe'), expectedVersion: 1 }, 'carol', 'unknown-' + kind)).status, 400);
    }
  } finally { await app.close(); }
});

test('Wiki/Paste exact preference recovery verifies receipt identity before loading another owner or object', async () => {
  const app = await start();
  try {
    const id = app.source('wiki'), otherId = app.source('paste');
    const original = await app.act(id, 'unmute'), otherKey = await app.act(id, 'unmute'), foreign = await app.act(id, 'unmute', 'bob'), otherObject = await app.act(otherId, 'unmute');
    const row = app.store.database.prepare('SELECT key,body FROM idempotency WHERE key LIKE ?').get('%:' + original.key) as { key: string; body: string };
    const getter = app.store.objectSubscriptions.operation.bind(app.store.objectSubscriptions); let foreignReads = 0;
    app.store.objectSubscriptions.operation = operationId => { if ([foreign.receipt.operationId, otherObject.receipt.operationId].includes(operationId)) { foreignReads++; throw new Error('Private foreign evidence loaded'); } return getter(operationId); };
    for (const body of [otherKey.receipt, foreign.receipt, { ...original.receipt, operationId: foreign.receipt.operationId }, { ...original.receipt, operationId: otherObject.receipt.operationId }, { ...original.receipt, changed: true }]) {
      app.store.database.prepare('UPDATE idempotency SET body=? WHERE key=?').run(JSON.stringify(body), row.key);
      const rejected = await app.request(app.path(id), 'POST', original.data, 'carol', original.key); assert.equal(rejected.status, 409); assert.equal(rejected.body.code, 'OBJECT_SUBSCRIPTION_INVALID_RECEIPT');
    }
    assert.equal(foreignReads, 0); app.store.database.prepare('UPDATE idempotency SET body=? WHERE key=?').run(row.body, row.key); app.store.objectSubscriptions.operation = getter;
    app.store.objectSubscriptions.operation = () => { throw new Error('Presentation failure'); };
    const denied = await app.request(app.path(id), 'POST', app.input(id, 'subscribe'), 'carol', 'atomic-failure'); assert.equal(denied.status, 409); app.store.objectSubscriptions.operation = getter;
    assert.equal(app.store.objectSubscriptions.status(id, app.carol.id).version, 0); assert.equal(app.store.database.prepare('SELECT 1 FROM idempotency WHERE key LIKE ?').get('%:atomic-failure'), undefined);
    const policy = app.policies.createSpace({ name: 'Hidden sources', view: members(app.alice.id), edit: members(app.alice.id) }, app.alice.id); app.policy(id, { spaceId: policy.id });
    assert.equal((await app.request(app.path(id), 'POST', original.data, 'carol', original.key)).status, 404); assert.equal((await app.request(app.path(id) + '/mute-history', 'GET', undefined, 'carol')).status, 404);
  } finally { await app.close(); }
});

test('Paste historical comments opt in once and inbox read boundaries retain immutable source context', async () => {
  const app = await start();
  try {
    const id = app.source('paste'); app.store.pastes.update(id, { expectedVersion: 1, content: 'Later content' }, app.actor);
    const comment = { contentVersion: 1, body: 'Private historical comment text' };
    const first = await app.request(`/api/pastes/${id}/comments`, 'POST', comment, 'carol', 'comment-once'); assert.equal(first.status, 201);
    assert.equal(app.store.objectSubscriptions.status(id, app.carol.id).following, true); const history = app.store.objectSubscriptions.history(id);
    assert.equal(history.transactions[0]!.reason, 'comment');
    assert.equal((await app.request(`/api/pastes/${id}/comments`, 'POST', comment, 'carol', 'comment-once')).status, 201); assert.deepEqual(app.store.objectSubscriptions.history(id), history);
    await app.act(id, 'unsubscribe'); await app.request(`/api/pastes/${id}/comments`, 'POST', comment, 'carol', 'comment-optout'); assert.equal(app.store.objectSubscriptions.status(id, app.carol.id).following, false);
    const inbox = (await app.request<NotificationInbox>('/api/notifications')).body; assert.equal(inbox.items[0]!.event.kind, 'paste_commented'); assert.deepEqual(inbox.items[0]!.event.context, { kind: 'paste', pasteVersion: 2, contentVersion: 1, contentHash: app.store.pastes.version(id, 1).sha256 });
    assert.doesNotMatch(JSON.stringify(inbox), /Private historical comment text|credentialId|requestId/);
    const input = { action: 'read_object', objectId: id, horizon: inbox.horizon, expectedAccessEpoch: inbox.accessEpoch };
    await app.request(`/api/pastes/${id}/comments`, 'POST', comment, 'carol', 'newer-comment');
    assert.equal((await app.request('/api/notifications/read', 'POST', input, 'alice', 'read-paste')).status, 200); assert.equal((await app.summary('alice')).unreadCount, 1);
    assert.equal((await app.request('/api/notifications/read', 'POST', input, 'alice', 'read-paste')).status, 200); assert.equal((await app.summary('alice')).unreadCount, 1);
  } finally { await app.close(); }
});
