import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Store } from './store.ts';
import { createApp } from './app.ts';
import { createAuth } from './auth.ts';
import type { SuiteDetail, SuiteList } from '../shared/suite.ts';

async function fixture() {
  const store = new Store({ path: ':memory:' }), provisioning = createAuth({ database: store.database, mode: 'local', basePath: '/', provisioning: true });
  const alice = await provisioning.createAccount({ username: 'alice', displayName: 'Alice', password: 'Suite test Alice passphrase' });
  const bob = await provisioning.createAccount({ username: 'bob', displayName: 'Bob', password: 'Suite test Bob passphrase' });
  const app = createApp({ store, seed: false, authMode: 'password' });
  const tokens = { alice: app.auth.createToken(alice.id, { name: 'Writer', scopes: ['read', 'write'] }).token, bob: app.auth.createToken(bob.id, { name: 'Writer', scopes: ['read', 'write'] }).token, reader: app.auth.createToken(alice.id, { name: 'Reader', scopes: ['read'] }).token };
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  async function request<T = SuiteDetail>(path: string, body?: unknown, who: keyof typeof tokens = 'alice', key = randomUUID()) {
    const result = await fetch(base + '/api/suite/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${tokens[who]}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Idempotency-Key': key }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: result.status, body: await result.json() as T };
  }
  return { ...app, alice, bob, request, close: async () => { await app.close(); store.close(); } };
}
const poll = { kind: 'poll', title: 'Pick a meeting day', choices: ['Monday', 'Tuesday'], method: 'single', responseVisibility: 'owner' };
test('application APIs enforce private access, scoped credentials, stale versions and exact retry identity', async () => {
  const f = await fixture(); try {
    const key = randomUUID(), input = { ...poll, access: { visibility: 'members' } };
    const created = await f.request('slowvote', input, 'alice', key); assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.record.id;
    assert.equal((await f.request(`slowvote/${id}`, undefined, 'bob')).status, 404);
    assert.deepEqual((await f.request<SuiteList>('slowvote', undefined, 'bob')).body.records, []);
    assert.equal((await f.request('slowvote', poll, 'reader')).status, 403);
    const retry = await f.request('slowvote', input, 'alice', key); assert.equal(retry.status, 201); assert.equal(retry.body.record.id, id);
    assert.equal((await f.request('slowvote', { ...input, title: 'Different' }, 'alice', key)).status, 409);
    assert.equal((await f.request(`slowvote/${id}/close`, { expectedVersion: 1 })).status, 200);
    assert.equal((await f.request(`slowvote/${id}/reopen`, { expectedVersion: 1 })).status, 409);
    assert.equal((await f.request(`calendar/${id}`)).status, 404);
    assert.equal(f.store.database.prepare('SELECT count(*) AS n FROM suite_records').get()!.n, 1);
  } finally { await f.close(); }
});
test('restricted poll responses and history are projected under current access on every read and retry', async () => {
  const f = await fixture(); try {
    const created = await f.request('slowvote', poll), id = created.body.record.id, key = randomUUID(), vote = { expectedVersion: 1, choiceIds: ['option-1'] };
    const voted = await f.request(`slowvote/${id}/vote`, vote, 'bob', key); assert.equal(voted.status, 200);
    assert.equal(voted.body.record.data.results, null); assert.equal('ballots' in voted.body.record.data, false);
    const detail = await f.request(`slowvote/${id}`); assert.equal((detail.body.record.data.results as unknown[]).length, 2);
    const restricted = await f.request(`slowvote/${id}/access`, { expectedVersion: 2, access: { visibility: 'members', memberIds: [], editorIds: [] } }); assert.equal(restricted.status, 200);
    assert.equal((await f.request(`slowvote/${id}/vote`, vote, 'bob', key)).status, 404);
    assert.equal((await f.request(`slowvote/${id}`, undefined, 'bob')).status, 404);
    assert.equal(f.store.database.prepare('SELECT count(*) AS n FROM suite_history WHERE record_id=?').get(id)!.n, 3);
  } finally { await f.close(); }
});
test('a conversation leave commits and acknowledges loss of access without replaying private messages', async () => {
  const f = await fixture(); try {
    const created = await f.request('conpherence', { kind: 'room', title: 'Private team', participantIds: [f.bob.id], message: 'Original private message' }), id = created.body.record.id;
    const sent = await f.request(`conpherence/${id}/message`, { expectedVersion: 1, body: 'A second message' }, 'bob'); assert.equal(sent.status, 200, JSON.stringify(sent.body));
    const key = randomUUID(), leave = { expectedVersion: 2 };
    const left = await f.request<{ record: null; unavailable: boolean }>(`conpherence/${id}/leave`, leave, 'alice', key);
    assert.equal(left.status, 200); assert.equal(left.body.record, null); assert.equal(left.body.unavailable, true);
    assert.equal((await f.request(`conpherence/${id}`, undefined, 'alice')).status, 404);
    assert.equal((await f.request(`conpherence/${id}/leave`, leave, 'alice', key)).status, 404);
    const remaining = await f.request(`conpherence/${id}`, undefined, 'bob'); assert.equal(remaining.status, 200); assert.equal(remaining.body.record.version, 3);
  } finally { await f.close(); }
});
test('Phame drafts and post receipts follow the current blog audience and editor roles', async () => {
  const f = await fixture(); try {
    const parent = await f.request('phame', { kind: 'blog', title: 'Research notes', authorIds: [f.bob.id] }), blogId = parent.body.record.id;
    const post = await f.request('phame', { kind: 'post', blogId, title: 'Private draft', body: 'Unpublished content.' }, 'bob'), id = post.body.record.id;
    assert.equal(post.status, 201, JSON.stringify(post.body)); assert.equal((await f.request(`phame/${id}`)).status, 200, 'blog owner may edit all posts');
    const publish = { expectedVersion: 1 }, key = randomUUID(); assert.equal((await f.request(`phame/${id}/publish`, publish, 'bob', key)).status, 200);
    assert.equal((await f.request(`phame/${blogId}/access`, { expectedVersion: 1, access: { visibility: 'members', memberIds: [], editorIds: [] } })).status, 200);
    assert.equal((await f.request(`phame/${id}`, undefined, 'bob')).status, 404, 'post authors cannot bypass current parent restrictions');
    assert.equal((await f.request(`phame/${id}/publish`, publish, 'bob', key)).status, 404);
  } finally { await f.close(); }
});
test('all six applications retain their distinct domain behavior through the authenticated API', async () => {
  const f = await fixture(); try {
    const network = await f.request('almanac', { kind: 'network', title: 'private-net', description: '', properties: {} }); assert.equal(network.status, 201, JSON.stringify(network.body));
    const event = await f.request('calendar', { kind: 'event', title: 'Meeting', timezone: 'UTC', allDay: false, start: '2026-11-02T10:00', end: '2026-11-02T11:00', inviteeIds: [f.bob.id] }); assert.equal(event.status, 201, JSON.stringify(event.body));
    const rsvp = await f.request(`calendar/${event.body.record.id}/rsvp`, { expectedVersion: 1, status: 'attending' }, 'bob'); assert.equal(rsvp.status, 200);
    const agreement = await f.request('legalpad', { kind: 'document', title: 'Contributor agreement', text: 'Read this exact agreement.', signatureType: 'individual', requiredSignerIds: [f.bob.id] }); assert.equal(agreement.status, 201, JSON.stringify(agreement.body));
    const version = (agreement.body.record.data.versions as { contentHash: string }[])[0]!;
    assert.equal((await f.request(`legalpad/${agreement.body.record.id}/sign`, { expectedVersion: 1, documentVersion: 1, contentHash: version.contentHash, agree: true, signerName: 'Bob' }, 'bob')).status, 403, 'bearer tokens cannot sign personal agreements');
    assert.equal((await f.request(`almanac/${network.body.record.id}/access`, { expectedVersion: 1, access: { visibility: 'members' } })).status, 200);
    assert.equal((await f.request(`almanac/${network.body.record.id}`, undefined, 'bob')).status, 404);
  } finally { await f.close(); }
});
test('Space revocation hides application records and old successful receipts', async () => {
  const f = await fixture(); try {
    const members = { kind: 'principals' as const, principalIds: [f.alice.id, f.bob.id] };
    const space = f.policies.createSpace({ name: 'Restricted research', description: '', view: members, edit: { kind: 'principals', principalIds: [f.alice.id] } }, f.alice.id);
    const key = randomUUID(), input = { ...poll, access: { spaceId: space.id } }, created = await f.request('slowvote', input, 'bob', key); assert.equal(created.status, 201);
    f.policies.updateSpace(space.id, { expectedVersion: space.version, name: space.name, description: '', archived: false, view: { kind: 'principals', principalIds: [f.alice.id] }, edit: space.edit }, f.alice.id);
    assert.equal((await f.request(`slowvote/${created.body.record.id}`, undefined, 'bob')).status, 404);
    assert.equal((await f.request('slowvote', input, 'bob', key)).status, 404);
    assert.deepEqual((await f.request<SuiteList>('slowvote', undefined, 'bob')).body.records, []);
  } finally { await f.close(); }
});
