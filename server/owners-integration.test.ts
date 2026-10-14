import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createApp } from './app.ts';
import { createStore } from './store.ts';
import { createAuth } from './auth.ts';
import { emptySearchQuery, searchParameters, type SearchPage } from '../shared/search.ts';
import type { OwnersDefinition, OwnersDetail, OwnersHistory, OwnersList, OwnersReceipt, OwnersResolve } from '../shared/owners.ts';
import type { OwnersRoutingHistory } from '../shared/owners-routing.ts';

async function fixture(basePath: string) {
  const store = createStore({ path: ':memory:' }), provisioner = createAuth({ database: store.database, mode: 'local', basePath, provisioning: true });
  const alice = await provisioner.createAccount({ username: 'alice', displayName: 'Alice', password: 'Integration password Alice' });
  const bob = await provisioner.createAccount({ username: 'bob', displayName: 'Bob', password: 'Integration password Bob' });
  const app = createApp({ store, seed: false, authMode: 'password', basePath });
  const tokens = { alice: app.auth.createToken(alice.id, { name: 'Owners', scopes: ['read', 'write'] }), bob: app.auth.createToken(bob.id, { name: 'Owners', scopes: ['read', 'write'] }), read: app.auth.createToken(alice.id, { name: 'Owners reader', scopes: ['read'] }) };
  store.createRepository({ name: 'Compiler', remoteUrl: 'https://example.invalid/compiler.git' });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}${basePath === '/' ? '' : basePath.slice(0, -1)}`;
  const request = async <T = { error: string }>(actor: keyof typeof tokens | null, path: string, method = 'GET', body?: unknown, key = randomUUID()) => {
    const response = await fetch(`${origin}${path}`, { method, signal: AbortSignal.timeout(10000), headers: { ...(actor ? { Authorization: `Bearer ${tokens[actor].token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Idempotency-Key': key }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as T };
  };
  const definition: OwnersDefinition = { name: 'Compiler team', description: 'LexicalNebula', visibility: 'workspace', status: 'active', owners: [{ kind: 'person', id: bob.id }], paths: [{ repositoryId: 'R1', path: '/src', excluded: false }], dominion: 'strong', autoReview: 'none', auditing: 'none' };
  const epoch = async () => (await request<OwnersList>('alice', '/api/owners')).body.accessEpoch;
  const search = async (actor: keyof typeof tokens, fields: Partial<ReturnType<typeof emptySearchQuery>> = {}) => request<SearchPage>(actor, '/api/search?' + searchParameters({ ...emptySearchQuery(), kinds: ['owners'], ...fields }));
  return { store, app, alice, bob, tokens, request, epoch, search, definition, close: async () => { await app.close(); store.close(); } };
}
for (const basePath of ['/', '/workspace/']) test(`Owners HTTP, search and source evidence enforce current authority at ${basePath}`, async () => {
  const f = await fixture(basePath);
  try {
    assert.equal((await f.request(null, '/api/owners')).status, 401);
    assert.equal((await f.request(null, '/api/owners-routing/D1')).status, 401);
    const input = { ...f.definition, expectedAccessEpoch: await f.epoch() }, key = randomUUID();
    assert.equal((await f.request('read', '/api/owners', 'POST', input)).status, 403);
    const created = await f.request<OwnersReceipt>('alice', '/api/owners', 'POST', input, key);
    assert.equal(created.status, 200, JSON.stringify(created.body)); const id = created.body.receipt.id;
    assert.equal((await f.request<OwnersDetail>('bob', `/api/owners/${id}`)).body.canEdit, true);
    assert.equal((await f.request<OwnersDetail>('read', `/api/owners/${id}`)).body.canEdit, false);
    const found = await f.search('bob', { text: 'LexicalNebula', ownerIds: ['me'] });
    assert.equal(found.status, 200); assert.deepEqual(found.body.items.map(item => item.id), [id]);
    assert.equal('ownerIds' in found.body.items[0]!, false, 'search does not expose internal expanded membership');
    assert.equal((await f.search('alice', { ownerIds: ['me'] })).body.total, 0);
    assert.equal((await f.request<OwnersResolve>('bob', '/api/owners/resolve?' + new URLSearchParams({ repositoryId: 'R1', paths: '["src/compiler.ts"]' }))).body.matches[0]!.package.id, id);
    const changed = await f.request<OwnersReceipt>('alice', `/api/owners/${id}`, 'PUT', { ...f.definition, name: 'Private title', description: 'PrivateSourceMarker', visibility: 'private', owners: [], expectedVersion: 1, expectedAccessEpoch: await f.epoch() });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.equal((await f.request('bob', `/api/owners/${id}`)).status, 404);
    assert.equal((await f.request('bob', `/api/owners/${id}/history`)).status, 404);
    assert.equal((await f.search('bob', { text: 'PrivateSourceMarker' })).body.total, 0);
    assert.equal((await f.search('bob', { text: 'LexicalNebula' })).body.total, 0);
    assert.equal((await f.request<OwnersResolve>('bob', '/api/owners/resolve?' + new URLSearchParams({ repositoryId: 'R1', paths: '["src/compiler.ts"]' }))).body.matches.length, 0);
    const retry = await f.request<OwnersReceipt>('alice', '/api/owners', 'POST', input, key);
    assert.equal(retry.body.receipt.replayed, true); assert.equal(retry.body.receipt.version, 1); assert.equal(retry.body.package!.version, 2);
    assert.deepEqual((await f.request<OwnersHistory>('alice', `/api/owners/${id}/history`)).body.history.map(row => row.package.version), [2, 1]);
    const revision = f.store.createRevision({ title: 'Read evidence', kind: 'code', repositoryId: 'R1', summary: '', testPlan: 'Check source', files: [{ path: 'src/file.ts', content: 'export const n = 1;' }] });
    const routing = await f.request<OwnersRoutingHistory>('read', `/api/owners-routing/${revision.revision.id}`);
    assert.equal(routing.status, 200, JSON.stringify(routing.body)); assert.deepEqual(routing.body.records, []);
    f.app.auth.revokeToken(f.alice.id, f.tokens.alice.record.id);
    assert.equal((await f.request('alice', '/api/owners', 'POST', input, key)).status, 401);
    assert.equal((await f.request('alice', `/api/owners/${id}/history`)).status, 401);
  } finally { await f.close(); }
});
test('Owners full-text search expands current inherited project ownership and removes revoked membership immediately', async () => {
  const f = await fixture('/');
  try {
    const parent = f.store.createProject({ name: 'Engineering', memberIds: [f.bob.id] });
    const preview = f.store.projectChildPreview(parent.id, 'milestone');
    const project = f.store.createProject({ name: 'Compiler milestone', parentId: parent.id, kind: 'milestone', expectedParentVersion: preview.expectedParentVersion, expectedHierarchyVersion: preview.expectedHierarchyVersion, expectedParentMembersVersion: preview.expectedParentMembersVersion });
    const created = await f.request<OwnersReceipt>('alice', '/api/owners', 'POST', { ...f.definition, owners: [{ kind: 'project', id: project.id }], expectedAccessEpoch: await f.epoch() });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal((await f.search('bob', { ownerIds: ['me'] })).body.total, 1);
    f.store.updateProjectMembers(parent.id, { action: 'remove', principalIds: [f.bob.id], expectedCollectionVersion: f.store.projectMembers(parent.id, f.alice.id).collectionVersion });
    assert.equal((await f.search('bob', { ownerIds: ['me'] })).body.total, 0);
    assert.equal((await f.search('bob', { ownerIds: ['none'] })).body.total, 1);
  } finally { await f.close(); }
});
