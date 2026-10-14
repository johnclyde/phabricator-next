import test from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Store } from './store.ts';
import { createAuth, type Auth } from './auth.ts';
import { PolicyStore } from './policy.ts';
import { createOwnersStore, localOwnersPackageIds } from './owners.ts';
import { OwnersService } from './owners-routes.ts';
import { ownersDefinition, type OwnersReceipt } from '../shared/owners.ts';

const request = { method: 'GET', headers: { host: '127.0.0.1:4310' } } as IncomingMessage;
async function fixture(path = ':memory:') {
  const store = new Store({ path });
  const provision = createAuth({ database: store.database, mode: 'local', basePath: '/', provisioning: true });
  const account = await provision.createAccount({ username: 'alice', displayName: 'Alice', password: 'Owners handoff fixture password' });
  const other = await provision.createAccount({ username: 'bob', displayName: 'Bob', password: 'Owners handoff other fixture password' });
  const local = provision.authenticate(request), policies = new PolicyStore(store.database, { principalExists: id => id === local.principalId || provision.listAccounts().some(person => person.id === id && !person.disabled) });
  const repository = store.createRepository({ name: 'Private local source', remoteUrl: 'https://example.invalid/private.git' });
  const space = policies.createSpace({ name: 'Private local space' }, local.principalId);
  policies.configureNew(repository.id, { spaceId: space.id }, local.principalId);
  const service = new OwnersService(store, provision, policies);
  const created = service.mutate('POST', '/api/owners', { name: 'Private local owners', description: 'Preserve package history', status: 'active', visibility: 'private', owners: [{ kind: 'person', id: local.principalId }, { kind: 'person', id: other.id }], dominion: 'strong', autoReview: 'review', auditing: 'all', paths: [{ repositoryId: repository.id, path: '/', excluded: false }], expectedAccessEpoch: policies.epoch() }, randomUUID(), local).body as OwnersReceipt;
  const operator: Auth = createAuth({ database: store.database, mode: 'local', basePath: '/', provisioning: true, transferOwnersPackages: (from, to, actor) => createOwnersStore(store, operator, policies).transferLocal(from, to, actor) });
  return { store, provision, operator, account, other, local, policies, service, created: created.package!, space, repository, close: () => store.close() };
}
const snapshot = (store: Store) => ['owners_packages', 'owners_history', 'owners_operations', 'policy_spaces', 'object_policies', 'policy_meta', 'activity'].map(name => store.database.prepare('SELECT * FROM ' + name + ' ORDER BY rowid').all());

test('Owners local account activation blocks silent orphaning and terminal handoff preserves immutable history and routing authority', async () => {
  const f = await fixture();
  try {
    const before = snapshot(f.store), originalHistory = f.store.database.prepare('SELECT * FROM owners_history WHERE version=1').get();
    assert.throws(() => createAuth({ database: f.store.database, mode: 'password', basePath: '/' }), /Owners packages reference local-only/);
    assert.deepEqual(snapshot(f.store), before);
    assert.throws(() => f.provision.transferLocalPolicies(f.account.id), /Owners package transfer requires/);
    assert.deepEqual(snapshot(f.store), before, 'missing callbacks roll policy changes back');
    const result = f.operator.transferLocalPolicies(f.account.id);
    assert.equal(result.ownersPackages, 1); assert.equal(result.spaces, 1);
    assert.deepEqual(f.store.database.prepare('SELECT * FROM owners_history WHERE version=1').get(), originalHistory);
    const history = f.service.packages.history(f.created.id, f.account.id);
    assert.deepEqual(history.map(value => value.package.version), [2, 1]);
    assert.equal(history[0]!.actorId, 'operator:' + f.local.workspaceId);
    assert.equal(history[0]!.package.creatorId, f.local.principalId, 'creation attribution is not rewritten');
    assert.deepEqual(history[0]!.package.owners.map(value => value.id), [f.account.id, f.other.id]);
    assert.equal(f.store.database.prepare('SELECT authority_id FROM owners_history WHERE version=2').get()!.authority_id, f.account.id);
    assert.equal(f.service.packages.active()[0]!.id, f.created.id);
    assert.deepEqual(localOwnersPackageIds(f.store.database, f.local.principalId), []);
    const after = snapshot(f.store); assert.equal(f.operator.transferLocalPolicies(f.account.id).ownersPackages, 0); assert.deepEqual(snapshot(f.store), after);
    const auth = createAuth({ database: f.store.database, mode: 'password', basePath: '/' }), packages = createOwnersStore(f.store, auth, f.policies);
    assert.equal(packages.canEdit(packages.get(f.created.id, f.account.id), f.account.id), true);
    assert.equal(packages.active()[0]!.id, f.created.id);
    assert.throws(() => f.operator.transferLocalPolicies(f.account.id), /before password authentication is activated/);
  } finally { f.close(); }
});

test('Owners handoff rolls back every policy and package change if a package history write fails', async () => {
  const f = await fixture();
  try {
    f.store.database.exec("CREATE TRIGGER fail_owners_transfer BEFORE INSERT ON owners_history WHEN NEW.version=2 BEGIN SELECT RAISE(ABORT,'Injected Owners transfer failure'); END");
    const before = snapshot(f.store); assert.throws(() => f.operator.transferLocalPolicies(f.account.id), /Injected Owners transfer failure/); assert.deepEqual(snapshot(f.store), before);
    assert.equal(f.store.database.prepare("SELECT value FROM auth_meta WHERE name='require_auth'").get(), undefined);
    f.provision.setAccountDisabled(f.account.id, true);
    assert.throws(() => f.operator.transferLocalPolicies(f.account.id), /Active account not found/); assert.deepEqual(snapshot(f.store), before);
  } finally { f.close(); }
});

test('Owners terminal transfer retains archived definitions', async () => {
  const f = await fixture();
  try {
    const archived = f.service.mutate('PUT', '/api/owners/' + f.created.id, { ...ownersDefinition(f.created), status: 'archived', expectedVersion: 1, expectedAccessEpoch: f.policies.epoch() }, randomUUID(), f.local).body as OwnersReceipt;
    assert.equal(archived.package!.status, 'archived');
    const before = f.policies.policy(f.repository.id, f.local.principalId);
    f.policies.setPolicy(f.repository.id, { expectedVersion: before.version, spaceId: before.spaceId, view: { kind: 'workspace' }, edit: { kind: 'principals', principalIds: [f.local.principalId] }, interact: { kind: 'workspace' } }, f.local.principalId);
    const transferred = f.operator.transferLocalPolicies(f.account.id); assert.equal(transferred.ownersPackages, 1);
    const pkg = f.service.packages.get(f.created.id, f.account.id); assert.equal(pkg.status, 'archived'); assert.equal(pkg.version, 3);
    assert.deepEqual(f.service.packages.active(), []);
  } finally { f.close(); }
});

test('Owners terminal handoff refuses to manufacture repository edit grants and rolls earlier policy transfers back', async () => {
  const f = await fixture();
  try {
    const second = f.store.createRepository({ name: 'Other editors repository', remoteUrl: 'https://example.invalid/other.git' });
    f.service.mutate('PUT', '/api/owners/' + f.created.id, { ...ownersDefinition(f.created), paths: [...f.created.paths, { repositoryId: second.id, path: '/', excluded: false }], expectedVersion: 1, expectedAccessEpoch: f.policies.epoch() }, randomUUID(), f.local);
    const before = f.policies.policy(second.id, f.other.id);
    f.policies.setPolicy(second.id, { expectedVersion: before.version, spaceId: before.spaceId, view: { kind: 'workspace' }, edit: { kind: 'principals', principalIds: [f.other.id] }, interact: { kind: 'workspace' } }, f.other.id);
    const unchanged = snapshot(f.store);
    assert.throws(() => f.operator.transferLocalPolicies(f.account.id), /Edit access to every attached repository/);
    assert.deepEqual(snapshot(f.store), unchanged);
  } finally { f.close(); }
});

test('accounts transfer-local CLI includes Owners packages and does not activate sign-in', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'owners-transfer-cli-')), path = join(directory, 'workspace.sqlite'), f = await fixture(path);
  try {
    const run = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/accounts.ts', 'transfer-local', 'alice'], { env: { ...process.env, DATABASE_PATH: path }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = ''; child.stdout.on('data', data => { stdout += String(data); }); child.stderr.on('data', data => { stderr += String(data); }); child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr }));
    });
    assert.equal(run.code, 0, run.stderr); assert.match(run.stdout, /1 Owners package\(s\)/); assert.match(run.stdout, /Password authentication remains inactive/);
    assert.equal(f.store.database.prepare("SELECT value FROM auth_meta WHERE name='require_auth'").get(), undefined);
    assert.equal(f.service.packages.get(f.created.id, f.account.id).version, 2);
  } finally { f.close(); await rm(directory, { recursive: true, force: true }); }
});
