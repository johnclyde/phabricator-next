import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from './app.ts';
import { createAuth } from './auth.ts';
import { Store } from './store.ts';
import { isRepositoryOperations, validRepositorySyncReceipt, type RepositoryOperations } from '../shared/repository-sync.ts';
import type { RepositorySyncBinding } from './repository-sync.ts';

async function fixture(basePath = '/', mode: 'observe' | 'host' = 'observe') {
  const store = new Store({ path: ':memory:' }), provisioner = createAuth({ database: store.database, mode: 'local', provisioning: true, basePath });
  const alice = await provisioner.createAccount({ username: 'alice', displayName: 'Alice', password: 'Repository operation fixture alice password' });
  const bob = await provisioner.createAccount({ username: 'bob', displayName: 'Bob', password: 'Repository operation fixture bob password' });
  const path = join(tmpdir(), `repository-operations-api-${randomUUID()}.git`), credentialFile = join(tmpdir(), 'operator-fixture-credential');
  const binding: RepositorySyncBinding = { repositoryId: 'R1', path, mode, intervalSeconds: 300, ...(mode === 'observe' ? { observe: { url: 'https://source.example.invalid/operator/upstream.git', credentialFile } } : { mirrors: [{ key: 'github', url: 'https://mirror.example.invalid/operator/destination.git', credentialFile }] }) };
  const app = createApp({ store, seed: false, authMode: 'password', basePath, repositorySyncBindings: [binding], repositorySyncOptions: { transport: { sync: async () => ({ changedRefs: 0 }) } } });
  store.createRepository({ name: 'Configured source', remoteUrl: 'https://example.invalid/registered.git' });
  store.createRepository({ name: 'Registered only', remoteUrl: 'https://example.invalid/registered-only.git' });
  const writer = app.auth.createToken(alice.id, { name: 'Sync writer', scopes: ['read', 'write'] }).token;
  const reader = app.auth.createToken(alice.id, { name: 'Status reader', scopes: ['read'] }).token;
  const otherWriter = app.auth.createToken(bob.id, { name: 'Other editor', scopes: ['read', 'write'] }).token;
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const api = async <T = { error: string; code?: string }>(path: string, method = 'GET', body?: unknown, token: string | null = writer, key: string | null = randomUUID()) => {
    const response = await fetch(`${origin}${basePath}api${path}`, { method, signal: AbortSignal.timeout(10_000), headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(key === null ? {} : { 'Idempotency-Key': key }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as T };
  };
  const operation = () => api<RepositoryOperations>('/repositories/R1/operations');
  const pins = async () => { const value = (await operation()).body; assert.ok(isRepositoryOperations(value, 'R1')); return { expectedConfiguration: value.snapshot.configuration!, expectedAccessEpoch: value.accessEpoch }; };
  const policy = (rules: Record<string, unknown>) => { const old = app.policies.policy('R1', bob.id); app.policies.setPolicy('R1', { expectedVersion: old.version, spaceId: old.spaceId, ...old.rules, ...rules }, bob.id); };
  return { ...app, alice, bob, writer, reader, otherWriter, path, credentialFile, origin, binding, api, operation, pins, policy, close: async () => { await app.close(); store.close(); } };
}

for (const basePath of ['/', '/workspace/']) for (const mode of ['observe', 'host'] as const) test(`repository operations expose safe ${mode} status and an exact clone URL at ${basePath}`, async () => {
  const app = await fixture(basePath, mode);
  try {
    const read = await app.api<RepositoryOperations>('/repositories/R1/operations', 'GET', undefined, app.reader);
    assert.equal(read.status, 200); assert.ok(isRepositoryOperations(read.body, 'R1'));
    assert.equal(read.body.snapshot.mode, mode); assert.equal(read.body.canSync, false);
    assert.equal(read.body.cloneUrl, `${app.origin}${basePath}git/R1.git`); assert.equal(read.body.pendingReceives, 0);
    const text = JSON.stringify(read.body);
    for (const secret of [app.path, app.credentialFile, 'source.example.invalid', 'mirror.example.invalid']) assert.equal(text.includes(secret), false);
    assert.equal((await app.operation()).body.canSync, true);
    const unconfigured = await app.api<RepositoryOperations>('/repositories/R2/operations');
    assert.equal(unconfigured.status, 200); assert.equal(unconfigured.body.snapshot.mode, 'unconfigured'); assert.equal(unconfigured.body.canSync, false); assert.equal(unconfigured.body.cloneUrl, null);
    assert.equal((await app.api('/repositories/R999/operations')).status, 404);
    assert.equal((await app.api('/repositories/R1/operations', 'GET', undefined, null)).status, 401);
  } finally { await app.close(); }
});

test('synchronization requires write scope and exact pins, and repeated requests never schedule duplicates', async () => {
  const app = await fixture();
  try {
    const input = await app.pins(), endpoint = '/repositories/R1/operations/sync', key = 'explicit-sync';
    const requested = () => Number(app.store.database.prepare('SELECT requested FROM repository_sync_targets WHERE repository_id=?').get('R1')!.requested);
    const before = requested();
    assert.equal((await app.api(endpoint, 'POST', input, app.reader, key)).status, 403);
    assert.equal((await app.api(endpoint, 'POST', input, app.writer, null)).status, 400);
    assert.equal((await app.api(endpoint, 'POST', { ...input, expectedConfiguration: 'f'.repeat(64) }, app.writer, key)).status, 409);
    assert.equal((await app.api(endpoint, 'POST', { ...input, expectedAccessEpoch: input.expectedAccessEpoch + 1 }, app.writer, key)).status, 409);
    assert.equal((await app.api(endpoint, 'POST', { ...input, url: 'https://unexpected.example.invalid/' }, app.writer, key)).status, 400);
    assert.equal((await app.api(`${endpoint}?force=true`, 'POST', input, app.writer, key)).status, 400);
    assert.equal(requested(), before);
    const first = await app.api<RepositoryOperations>(endpoint, 'POST', input, app.writer, key); assert.equal(first.status, 200); assert.ok(validRepositorySyncReceipt(first.body, 'R1', key, input)); assert.equal(first.body.receipt!.replayed, false);
    assert.equal(requested(), before + 1);
    const retry = await app.api<RepositoryOperations>(endpoint, 'POST', input, app.writer, key); assert.equal(retry.status, 200); assert.ok(validRepositorySyncReceipt(retry.body, 'R1', key, input)); assert.equal(retry.body.receipt!.replayed, true); assert.equal(requested(), before + 1);
    const other = await app.api<RepositoryOperations>(endpoint, 'POST', input, app.otherWriter, key); assert.equal(other.status, 200); assert.equal(other.body.receipt!.replayed, false); assert.equal(requested(), before + 2);
    assert.equal((await app.api('/repositories/R2/operations/sync', 'POST', input)).status, 409);
  } finally { await app.close(); }
});

test('repository view/edit policy and live token revocation apply before replaying sync receipts', async () => {
  const app = await fixture();
  try {
    const endpoint = '/repositories/R1/operations/sync', input = await app.pins(), key = 'before-revocation';
    assert.equal((await app.api(endpoint, 'POST', input, app.writer, key)).status, 200);
    app.policy({ edit: { kind: 'principals', principalIds: [app.bob.id] } });
    const read = await app.operation(); assert.equal(read.status, 200); assert.equal(read.body.canSync, false);
    assert.ok([403, 404].includes((await app.api(endpoint, 'POST', input, app.writer, key)).status));
    app.policy({ view: { kind: 'principals', principalIds: [app.bob.id] } });
    assert.equal((await app.operation()).status, 404);
    const bobPins = (await app.api<RepositoryOperations>('/repositories/R1/operations', 'GET', undefined, app.otherWriter)).body;
    const bobInput = { expectedConfiguration: bobPins.snapshot.configuration!, expectedAccessEpoch: bobPins.accessEpoch };
    assert.equal((await app.api(endpoint, 'POST', bobInput, app.otherWriter, key)).status, 200);
    app.store.database.prepare('UPDATE auth_accounts SET disabled=1 WHERE id=?').run(app.bob.id);
    assert.equal((await app.api(endpoint, 'POST', bobInput, app.otherWriter, key)).status, 401);
  } finally { await app.close(); }
});

test('an unrelated access change refuses stale sync replay without changing the original request', async () => {
  const app = await fixture();
  try {
    const input = await app.pins(), key = 'stale-access-replay', endpoint = '/repositories/R1/operations/sync';
    assert.equal((await app.api(endpoint, 'POST', input, app.writer, key)).status, 200);
    const original = app.store.database.prepare('SELECT * FROM repository_sync_requests').all();
    app.policy({ interact: { kind: 'principals', principalIds: [app.bob.id] } });
    assert.equal((await app.api(endpoint, 'POST', input, app.writer, key)).status, 409);
    assert.deepEqual(app.store.database.prepare('SELECT * FROM repository_sync_requests').all(), original);
  } finally { await app.close(); }
});

test('observation and local landing cannot share authority; hosted browsing and landing must share storage', () => {
  const path = join(tmpdir(), 'repository-authority-fixture.git'), binding: RepositorySyncBinding = { repositoryId: 'R1', path, mode: 'observe', observe: { url: 'https://example.invalid/upstream.git' } };
  const landing = { key: 'primary', repositoryId: 'R1', repositoryPath: path, branches: ['refs/heads/main'] };
  assert.throws(() => createApp({ repositorySyncBindings: [binding], landingBindings: [landing] }), /Observed repositories may not also receive local landings/);
  assert.throws(() => createApp({ repositorySyncBindings: [{ repositoryId: 'R1', path, mode: 'host' }], landingBindings: [{ ...landing, repositoryPath: `${path}-other` }] }), /same configured repository path/);
  assert.throws(() => createApp({ repositorySyncBindings: [binding], gitRepositories: { R1: `${path}-other` } }), /same configured path/);
});
