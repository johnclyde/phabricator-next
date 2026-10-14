import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { SessionState } from '../shared/auth.ts';
import type { SuiteDetail, SuiteList } from '../shared/suite.ts';
import type { LegalpadData } from '../shared/legalpad.ts';
import { Store } from './store.ts';
import { createApp } from './app.ts';
import { createAuth } from './auth.ts';

async function fixture() {
  const store = new Store({ path: ':memory:' }), provisioning = createAuth({ database: store.database, mode: 'local', basePath: '/', provisioning: true });
  const alice = await provisioning.createAccount({ username: 'alice', displayName: 'Alice', password: 'Suite access Alice passphrase' }), bob = await provisioning.createAccount({ username: 'bob', displayName: 'Bob', password: 'Suite access Bob passphrase' }), carol = await provisioning.createAccount({ username: 'carol', displayName: 'Carol', password: 'Suite access Carol passphrase' });
  const app = createApp({ store, seed: false, authMode: 'password' });
  const tokens = { alice: app.auth.createToken(alice.id, { name: 'Writer', scopes: ['read', 'write'] }).token, bob: app.auth.createToken(bob.id, { name: 'Writer', scopes: ['read', 'write'] }).token, carol: app.auth.createToken(carol.id, { name: 'Writer', scopes: ['read', 'write'] }).token };
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const sessions: Partial<Record<keyof typeof tokens, Record<string, string>>> = {};
  async function login(who: keyof typeof tokens) {
    const bootstrap = await fetch(origin + '/api/session'), challenge = await bootstrap.json() as SessionState;
    const response = await fetch(origin + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: bootstrap.headers.getSetCookie().map(value => value.split(';')[0]!).join('; '), 'X-CSRF-Token': challenge.csrfToken! }, body: JSON.stringify({ username: who, password: `Suite access ${who[0]!.toUpperCase()}${who.slice(1)} passphrase` }) });
    assert.equal(response.status, 200); const session = await response.json() as SessionState;
    sessions[who] = { Cookie: response.headers.getSetCookie().map(value => value.split(';')[0]!).join('; '), Origin: origin, 'X-Session-Context': session.sessionContext!, 'X-CSRF-Token': session.csrfToken! };
  }
  async function request<T = SuiteDetail>(path: string, body?: unknown, who: keyof typeof tokens = 'alice', key = randomUUID(), session = false) {
    const result = await fetch(origin + '/api/suite/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(session ? sessions[who]! : { Authorization: `Bearer ${tokens[who]}` }), ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Idempotency-Key': key }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: result.status, body: await result.json() as T };
  }
  async function create(input: unknown, who: keyof typeof tokens = 'alice') { const result = await request('almanac', input, who); assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body.record; }
  return { ...app, alice, bob, carol, request, login, create, close: async () => { await app.close(); store.close(); } };
}

test('Almanac inherited readers and editors follow the current device, network, service and Space', async () => {
  const f = await fixture(); try {
    const network = await f.create({ kind: 'network', title: 'shared-net' });
    const device = await f.create({ kind: 'device', title: 'shared-device', access: { editorIds: [f.bob.id] } });
    const iface = await f.create({ kind: 'interface', deviceId: device.id, networkId: network.id, address: 'host.example.test', port: 443 }, 'bob');
    const service = await f.create({ kind: 'service', title: 'service' });
    const binding = await f.create({ kind: 'binding', serviceId: service.id, interfaceId: iface.id });
    assert.equal((await f.request(`almanac/${iface.id}/properties`, { expectedVersion: 1, properties: { assigned: true } }, 'bob')).status, 200, 'device editor inherits interface editing');
    assert.equal((await f.request(`almanac/${binding.id}/properties`, { expectedVersion: 1, properties: {} }, 'bob')).status, 403, 'device editor does not gain service editing');
    assert.equal((await f.request(`almanac/${iface.id}/access`, { expectedVersion: 2, access: { visibility: 'members' } }, 'bob')).status, 409, 'interface policy cannot escape its parent');
    assert.equal((await f.request(`almanac/${device.id}/access`, { expectedVersion: 1, access: { editorIds: [] } })).status, 200);
    assert.equal((await f.request(`almanac/${iface.id}/properties`, { expectedVersion: 2, properties: {} }, 'bob')).status, 403, 'creator loses edit rights after parent role revocation');
    assert.equal((await f.request(`almanac/${network.id}/access`, { expectedVersion: 1, access: { visibility: 'members' } })).status, 200);
    assert.equal((await f.request(`almanac/${iface.id}`, undefined, 'bob')).status, 404); assert.equal((await f.request(`almanac/${binding.id}`, undefined, 'bob')).status, 404);
    const list = await f.request<SuiteList>('almanac', undefined, 'bob'); assert.ok(!list.body.records.some(item => [iface.id, binding.id].includes(item.id)));
  } finally { await f.close(); }
});

test('Almanac references remain policy intersections across Spaces and old receipts never bypass revocation', async () => {
  const f = await fixture(); try {
    const space = f.policies.createSpace({ name: 'Private network Space', description: '', view: { kind: 'principals', principalIds: [f.alice.id, f.bob.id] }, edit: { kind: 'principals', principalIds: [f.alice.id] } }, f.alice.id);
    const network = await f.create({ kind: 'network', title: 'restricted-net', access: { spaceId: space.id } });
    const device = await f.create({ kind: 'device', title: 'public-device', access: { editorIds: [f.bob.id] } });
    const key = randomUUID(), input = { kind: 'interface', deviceId: device.id, networkId: network.id, address: '10.0.1.2', port: 443, access: { spaceId: 'S1' } };
    const result = await f.request('almanac', input, 'bob', key); assert.equal(result.status, 201); const iface = result.body.record;
    assert.equal((await f.request(`almanac/${iface.id}`, undefined, 'carol')).status, 404, 'child in public Space cannot reveal private network');
    f.policies.updateSpace(space.id, { expectedVersion: space.version, name: space.name, description: '', archived: false, view: { kind: 'principals', principalIds: [f.alice.id] }, edit: space.edit }, f.alice.id);
    assert.equal((await f.request(`almanac/${iface.id}`, undefined, 'bob')).status, 404);
    assert.equal((await f.request('almanac', input, 'bob', key)).status, 404, 'create retry rechecks linked Spaces');
    assert.equal((await f.request('almanac', { ...input, address: '10.0.1.3' }, 'bob')).status, 404);
    assert.equal(f.store.database.prepare("SELECT count(*) AS n FROM suite_records WHERE kind='interface'").get()!.n, 1);
  } finally { await f.close(); }
});

test('Almanac global collisions and dependencies include records hidden from their parent owner without disclosing names', async () => {
  const f = await fixture(); try {
    const hidden = await f.create({ kind: 'network', title: 'undisclosed-name', access: { visibility: 'members' } }, 'bob');
    const duplicate = await f.request<{ error: string }>('almanac', { kind: 'network', title: 'UNDISCLOSED-NAME' }); assert.equal(duplicate.status, 409); assert.ok(!JSON.stringify(duplicate.body).includes(hidden.id)); assert.ok(!JSON.stringify(duplicate.body).includes(hidden.title));
    const network = await f.create({ kind: 'network', title: 'endpoint-network', access: { memberIds: [f.alice.id], visibility: 'members' } }, 'bob');
    const device = await f.create({ kind: 'device', title: 'parent-device', access: { editorIds: [f.bob.id] } });
    const iface = await f.create({ kind: 'interface', deviceId: device.id, networkId: network.id, address: 'host.test', port: 22 }, 'bob');
    assert.equal((await f.request(`almanac/${network.id}/access`, { expectedVersion: 1, access: { memberIds: [] } }, 'bob')).status, 200);
    assert.equal((await f.request(`almanac/${iface.id}`)).status, 404);
    const blocked = await f.request<{ error: string }>(`almanac/${device.id}/disable`, { expectedVersion: 1 }); assert.equal(blocked.status, 409); assert.ok(!JSON.stringify(blocked.body).includes(iface.id)); assert.ok(!JSON.stringify(blocked.body).includes(network.id));
    assert.equal((await f.request(`almanac/${iface.id}/disable`, { expectedVersion: 1 }, 'bob')).status, 200);
    assert.equal((await f.request(`almanac/${device.id}/disable`, { expectedVersion: 1 })).status, 200);
  } finally { await f.close(); }
});

test('Legalpad signed receipts are immutable, private, bound to current text and projected on exact replay', async () => {
  const f = await fixture(); try {
    await f.login('bob'); const created = await f.request('legalpad', { kind: 'document', title: 'Private receipt agreement', text: 'Original corporate terms.', signatureType: 'corporation', requiredSignerIds: [f.bob.id] }), id = created.body.record.id;
    const version = (created.body.record.data as LegalpadData).versions[0]!, key = randomUUID(), input = { expectedVersion: 1, documentVersion: 1, contentHash: version.contentHash, signerName: 'Bob', agree: true, companyName: 'Private Company', companyAddress: 'Private street', contactEmail: 'private@example.test', authority: true };
    const signed = await f.request(`legalpad/${id}/sign`, input, 'bob', key, true); assert.equal(signed.status, 200, JSON.stringify(signed.body)); const originalReceipt = (signed.body.record.data as LegalpadData).signatures[0]!;
    const stranger = await f.request(`legalpad/${id}`, undefined, 'carol'); assert.deepEqual((stranger.body.record.data as LegalpadData).signatures, []); assert.ok(!JSON.stringify(stranger.body).includes('Private Company')); assert.ok(!stranger.body.events.some(event => event.action === 'sign'));
    const list = await f.request<SuiteList>('legalpad', undefined, 'carol'); assert.ok(!JSON.stringify(list.body).includes('private@example.test'));
    assert.equal((await f.request(`legalpad/${id}/revise`, { expectedVersion: 2, title: 'Private receipt agreement', text: 'New terms.', signatureType: 'corporation' })).status, 200);
    const replay = await f.request(`legalpad/${id}/sign`, input, 'bob', key, true); assert.equal(replay.status, 200); assert.equal(replay.body.record.version, 3); assert.deepEqual((replay.body.record.data as LegalpadData).signatures[0], originalReceipt); assert.equal((replay.body.record.data as LegalpadData).requirements![0]!.status, 'required');
    assert.equal((await f.request(`legalpad/${id}/sign`, { ...input, expectedVersion: 3 }, 'bob', randomUUID(), true)).status, 409, 'old consent cannot follow newer record version');
    assert.equal((await f.request(`legalpad/${id}/withdraw`, { expectedVersion: 3, signatureId: originalReceipt.id, reason: 'Stolen receipt' }, 'carol')).status, 403, 'token cannot make a personal decision');
    assert.equal((await f.request(`legalpad/${id}/access`, { expectedVersion: 3, access: { visibility: 'members' } })).status, 200);
    assert.equal((await f.request(`legalpad/${id}/sign`, input, 'bob', key, true)).status, 404, 'revoked signer cannot recover a private receipt');
  } finally { await f.close(); }
});

test('Legalpad filtered signature history remains pageable and caller identity cannot be forged', async () => {
  const f = await fixture(); try {
    await f.login('bob'); await f.login('carol');
    const created = await f.request('legalpad', { kind: 'document', title: 'Paged signing history', text: 'Exact terms.', signatureType: 'individual' }), id = created.body.record.id, body = (created.body.record.data as LegalpadData).versions[0]!;
    const input = { expectedVersion: 1, documentVersion: 1, contentHash: body.contentHash, signerName: 'Claimed name', agree: true };
    assert.equal((await f.request(`legalpad/${id}/sign`, { ...input, signerId: f.alice.id }, 'bob', randomUUID(), true)).status, 400);
    const signed = await f.request(`legalpad/${id}/sign`, input, 'bob', randomUUID(), true); assert.equal(signed.status, 200); const receipt = (signed.body.record.data as LegalpadData).signatures[0]!; assert.equal(receipt.signerId, f.bob.id); assert.equal(receipt.actorId, f.bob.id);
    assert.equal((await f.request(`legalpad/${id}/withdraw`, { expectedVersion: 2, signatureId: receipt.id, reason: 'Not my receipt' }, 'carol', randomUUID(), true)).status, 404);
    const page = await f.request(`legalpad/${id}?limit=1`, undefined, 'carol'); assert.deepEqual(page.body.events, []); assert.ok(page.body.nextBefore);
    const older = await f.request(`legalpad/${id}?limit=1&before=${page.body.nextBefore}`, undefined, 'carol'); assert.equal(older.body.events[0]?.action, 'create');
    assert.equal((await f.request(`legalpad/${id}/withdraw`, { expectedVersion: 2, signatureId: receipt.id, reason: 'My withdrawal' }, 'bob', randomUUID(), true)).status, 200);
    const original = await f.request(`legalpad/${id}`); assert.deepEqual((original.body.record.data as LegalpadData).signatures[0], receipt); assert.equal((original.body.record.data as LegalpadData).revocations[0]?.actorId, f.bob.id);
  } finally { await f.close(); }
});
