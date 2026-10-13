import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp } from './app.ts';
import { createAuth } from './auth.ts';
import { Store } from './store.ts';
import type { AutomationConfiguration } from './automation.ts';
import type { GitObserver } from './git.ts';
import type { GitCommitResult } from '../shared/repositories.ts';
import type { DrydockAuthorization, DrydockBlueprint, DrydockClaim, DrydockLeaseDetail } from '../shared/drydock.ts';
import { HttpError } from './validation.ts';

const observed: GitCommitResult = { repositoryId: 'R1', objectFormat: 'sha1', commit: { id: 'a'.repeat(40), treeId: 'b'.repeat(40), parentIds: [], author: { name: 'Author', email: 'author@example.test', timestamp: '2026-01-01T00:00:00Z' }, committer: { name: 'Author', email: 'author@example.test', timestamp: '2026-01-01T00:00:00Z' }, message: 'Exact source', messageTruncated: false } };
const unavailable = async (): Promise<never> => { throw new HttpError(503, 'Unused observer method.'); };
const members = (...principalIds: string[]) => ({ kind: 'principals' as const, principalIds });
async function fixture() {
  const store = new Store({ path: ':memory:' }), provision = createAuth({ database: store.database, mode: 'local', basePath: '/', provisioning: true });
  const alice = await provision.createAccount({ username: 'alice', displayName: 'Lease holder', password: 'Alice lease replay fixture password' }), bob = await provision.createAccount({ username: 'bob', displayName: 'Bound worker', password: 'Bob lease replay fixture password' });
  const configuration: AutomationConfiguration = { managers: ['alice'], drydockBindings: [{ key: 'copy', worker: 'local-copy', repositoryIds: ['R1'] }], drydockWorkers: { 'local-copy': ['bob'] } };
  const observer: GitObserver = { info: unavailable, refs: unavailable, tree: unavailable, blob: unavailable, blame: unavailable, history: unavailable, compare: unavailable, patch: unavailable, compareFile: unavailable, importSnapshot: unavailable, commit: async () => observed };
  const app = createApp({ store, seed: false, authMode: 'password', automation: configuration, gitObserver: observer });
  await app.automation.close(); // Keep state changes under each regression's control.
  store.createRepository({ name: 'Source', remoteUrl: 'https://example.invalid/source.git' });
  const tokens = { alice: app.auth.createToken(alice.id, { name: 'Holder', scopes: ['read', 'write'] }).token, bob: app.auth.createToken(bob.id, { name: 'Worker', scopes: ['read', 'write'] }).token };
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  async function request<T>(path: string, input: unknown, who: keyof typeof tokens = 'alice', key = randomUUID(), method = 'POST') {
    const response = await fetch(origin + '/api/drydock' + path, { method, signal: AbortSignal.timeout(10_000), headers: { Authorization: `Bearer ${tokens[who]}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(input) }); return { status: response.status, body: await response.json() as T };
  }
  const configured = await request<{ blueprint: DrydockBlueprint }>('/blueprints', { name: 'Exact copy', description: '', enabled: true, repositoryId: 'R1', binding: 'copy', worker: 'local-copy', limit: 2 }); assert.equal(configured.status, 201);
  const blueprint = configured.body.blueprint, authorized = await request<{ authorization: DrydockAuthorization }>(`/blueprints/${blueprint.id}/authorizations`, { subjectKind: 'principal', subjectId: alice.id }); assert.equal(authorized.status, 201);
  const decision = await request<{ authorization: DrydockAuthorization }>(`/authorizations/${authorized.body.authorization.id}/commands`, { expectedVersion: authorized.body.authorization.version, status: 'approved' }); assert.equal(decision.status, 200);
  const allocated = await request<DrydockLeaseDetail>('/leases', { repositoryId: 'R1', commitId: observed.commit.id, blueprintId: blueprint.id, blueprintVersion: blueprint.version }); assert.equal(allocated.status, 201);
  const input = { expectedVersion: allocated.body.lease.version, worker: 'local-copy' }, key = randomUUID(), path = `/leases/${allocated.body.lease.id}/claim`;
  const claimed = await request<DrydockClaim>(path, input, 'bob', key); assert.equal(claimed.status, 200); assert.equal(claimed.body.operation, 'provision');
  const replay = () => request<DrydockClaim>(path, input, 'bob', key);
  const policy = (changes: Record<string, unknown>, principalId = alice.id) => { const current = app.policies.policy('R1', principalId); app.policies.setPolicy('R1', { expectedVersion: current.version, spaceId: current.spaceId, ...current.rules, ...changes }, principalId); };
  return { ...app, configuration, alice, bob, blueprint, authorization: decision.body.authorization, claim: claimed.body, replay, request, policy, close: async () => { await app.close(); store.close(); } };
}

for (const change of ['worker-binding', 'repository-edit', 'holder-edit', 'operator-binding', 'authorization', 'blueprint', 'expiry', 'fenced', 'active'] as const) test(`provision claim replay rejects ${change} changes without returning the saved capability`, async () => {
  const app = await fixture(); try {
    const valid = await app.replay(); assert.equal(valid.status, 200); assert.deepEqual(valid.body, app.claim);
    const before = app.store.database.prepare('SELECT body FROM idempotency ORDER BY rowid').all();
    if (change === 'worker-binding') app.configuration.drydockWorkers!['local-copy'] = ['alice'];
    else if (change === 'repository-edit') app.policy({ edit: members(app.alice.id) });
    else if (change === 'holder-edit') app.policy({ edit: members(app.bob.id) }, app.bob.id);
    else if (change === 'operator-binding') app.configuration.drydockBindings = [];
    else if (change === 'authorization') app.automation.drydock.authorizationCommand(app.authorization.id, { expectedVersion: app.authorization.version, status: 'revoked' }, { principalId: app.alice.id, displayName: app.alice.displayName, workspaceId: app.auth.workspaceId });
    else if (change === 'blueprint') { const { id: _id, version, ownerId: _owner, type: _type, createdAt: _created, updatedAt: _updated, ...input } = app.blueprint; app.automation.drydock.updateBlueprint(app.blueprint.id, { ...input, expectedVersion: version, enabled: false }, { principalId: app.alice.id, displayName: app.alice.displayName, workspaceId: app.auth.workspaceId }); }
    else if (change === 'expiry') app.store.database.prepare('UPDATE drydock_resources SET claim_until=? WHERE id=?').run(Date.now() - 1, app.claim.resource.id);
    else if (change === 'fenced') app.store.database.prepare('UPDATE drydock_resources SET claim_hash=NULL,operation=NULL WHERE id=?').run(app.claim.resource.id);
    else app.automation.drydock.report(app.claim.lease.id, { token: app.claim.token, reportId: 'ready', type: 'active' }, { principalId: app.bob.id, displayName: app.bob.displayName, workspaceId: app.auth.workspaceId });
    const replay = await app.replay(); assert.ok([403, 409].includes(replay.status), `${change}: ${JSON.stringify(replay)}`); assert.equal(JSON.stringify(replay.body).includes(app.claim.token), false); assert.equal('operation' in replay.body, false);
    assert.deepEqual(app.store.database.prepare('SELECT body FROM idempotency ORDER BY rowid').all(), before, 'rejected replay preserves its original immutable receipt');
  } finally { await app.close(); }
});

test('assigned cleanup claims and cleanup report replays remain available after repository and worker access are revoked', async () => {
  const app = await fixture(); try {
    const holder = { principalId: app.alice.id, displayName: app.alice.displayName, workspaceId: app.auth.workspaceId };
    const released = app.automation.drydock.command(app.claim.lease.id, { command: 'release', expectedVersion: app.claim.lease.version }, holder);
    app.configuration.drydockWorkers!['local-copy'] = ['alice']; app.configuration.drydockBindings = []; app.policy({ view: members(app.alice.id), edit: members(app.alice.id) });
    const input = { expectedVersion: released.lease.version, worker: 'local-copy' }, key = randomUUID(), path = `/leases/${app.claim.lease.id}/claim`;
    const claim = await app.request<DrydockClaim>(path, input, 'bob', key); assert.equal(claim.status, 200, JSON.stringify(claim.body)); assert.equal(claim.body.operation, 'release');
    const replay = await app.request<DrydockClaim>(path, input, 'bob', key); assert.equal(replay.status, 200); assert.equal(replay.body.token, claim.body.token);
    const report = { token: claim.body.token, reportId: 'cleaned', type: 'released' }, reportKey = randomUUID();
    const result = await app.request<DrydockLeaseDetail>(`/leases/${app.claim.lease.id}/report`, report, 'bob', reportKey); assert.equal(result.status, 200); assert.equal(result.body.lease.status, 'released');
    assert.equal((await app.request(`/leases/${app.claim.lease.id}/report`, report, 'bob', reportKey)).status, 200);
    assert.equal((await app.replay()).status, 404, 'the stale provisioning response remains inaccessible');
  } finally { await app.close(); }
});
