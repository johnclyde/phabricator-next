import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createApp } from './app.ts';
import { createStore } from './store.ts';
import { createAuth } from './auth.ts';
import { emptySearchQuery, searchParameters, type SearchPage, type SavedSearchReceipt, type SavedSearchList } from '../shared/search.ts';
import type { Task } from '../shared/types.ts';

async function fixture(basePath = '/') {
  const store = createStore({ path: ':memory:' }), provisioner = createAuth({ database: store.database, mode: 'local', basePath, provisioning: true });
  const alice = await provisioner.createAccount({ username: 'alice', displayName: 'Alice', password: 'Alice password sufficiently long' });
  const bob = await provisioner.createAccount({ username: 'bob', displayName: 'Bob', password: 'Bob password sufficiently long' });
  const app = createApp({ store, seed: false, authMode: 'password', basePath });
  const tokens = { alice: app.auth.createToken(alice.id, { name: 'Search', scopes: ['read', 'write'] }).token, bob: app.auth.createToken(bob.id, { name: 'Search', scopes: ['read', 'write'] }).token, read: app.auth.createToken(alice.id, { name: 'Read search', scopes: ['read'] }).token };
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}${basePath === '/' ? '' : basePath.slice(0, -1)}`;
  const request = async <T = { error: string }>(actor: keyof typeof tokens | null, path: string, method = 'GET', body?: unknown, key?: string) => {
    const response = await fetch(`${origin}${path}`, { method, signal: AbortSignal.timeout(10000), headers: { ...(actor ? { Authorization: `Bearer ${tokens[actor]}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Idempotency-Key': key ?? randomUUID() }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as T };
  };
  return { app, store, alice, bob, request, close: async () => { await app.close(); store.close(); } };
}
for (const basePath of ['/', '/workspace/']) test(`full-text and saved query HTTP routes respect authentication, write scopes and mount ${basePath}`, async () => {
  const f = await fixture(basePath); try {
    assert.equal((await f.request(null, '/api/search')).status, 401);
    const createdTask = await f.request<Task>('alice', '/api/tasks', 'POST', { title: 'Search integration', description: 'distantQuasar body match', priority: 'high' }); assert.equal(createdTask.status, 201, JSON.stringify(createdTask.body));
    const params = searchParameters({ ...emptySearchQuery(), text: 'distantQuasar', kinds: ['task'] });
    const page = await f.request<SearchPage>('read', `/api/search?${params}`); assert.equal(page.status, 200, JSON.stringify(page.body)); assert.equal(page.body.total, 1); assert.equal(page.body.items[0]!.id, createdTask.body.id);
    assert.equal((await f.request('alice', '/api/search?text=x&text=y')).status, 400);
    const input = { name: 'Personal research', visibility: 'private', query: { ...emptySearchQuery(), text: 'quasar*' } };
    assert.equal((await f.request('read', '/api/search/queries', 'POST', input)).status, 403);
    const saved = await f.request<SavedSearchReceipt>('alice', '/api/search/queries', 'POST', input, 'stable-query'); assert.equal(saved.status, 201, JSON.stringify(saved.body));
    const id = saved.body.query!.id;
    assert.equal((await f.request('bob', `/api/search/queries/${id}`)).status, 404);
    assert.equal((await f.request<SavedSearchList>('bob', '/api/search/queries')).body.queries.length, 0);
    const updated = await f.request<SavedSearchReceipt>('alice', `/api/search/queries/${id}`, 'POST', { ...input, visibility: 'workspace', expectedVersion: 1 }); assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal((await f.request<SavedSearchList>('bob', '/api/search/queries')).body.queries.length, 1);
    assert.equal((await f.request('bob', `/api/search/queries/${id}/delete`, 'POST', { expectedVersion: 2 })).status, 404);
    const retry = await f.request<SavedSearchReceipt>('alice', '/api/search/queries', 'POST', input, 'stable-query'); assert.equal(retry.status, 201); assert.equal(retry.body.receipt.replayed, true); assert.equal(retry.body.receipt.version, 1); assert.equal(retry.body.query!.version, 2);
    assert.equal((await f.request('alice', `/api/search/queries/${id}/delete`, 'POST', { expectedVersion: 2 })).status, 200);
    assert.equal((await f.request('bob', `/api/search/queries/${id}`)).status, 404);
  } finally { await f.close(); }
});
