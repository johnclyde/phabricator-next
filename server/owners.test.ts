import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { createAuth } from './auth.ts';
import { PolicyStore } from './policy.ts';
import { Store } from './store.ts';
import { initializeOwners } from './owners.ts';
import { OwnersService } from './owners-routes.ts';
import { matchOwners, ownersDefinition, ownersPath, parseOwnersDefinition, parseOwnersWrite, validOwnersReceipt, type OwnersDefinition, type OwnersDetail, type OwnersHistory, type OwnersList, type OwnersPackage, type OwnersReceipt, type OwnersResolve } from '../shared/owners.ts';

const status = (expected: number) => (error: unknown) => !!error && typeof error === 'object' && 'status' in error && error.status === expected;
const definition = (patch: Partial<OwnersDefinition> = {}): OwnersDefinition => ({ name: 'Compiler owners', description: 'Ownership of compiler source.', status: 'active', visibility: 'private', owners: [], dominion: 'strong', autoReview: 'none', auditing: 'none', paths: [{ repositoryId: 'R1', path: '/src', excluded: false }], ...patch });
const pkg = (name: string, patch: Partial<OwnersDefinition> = {}): OwnersPackage => ({ ...definition(patch), name, id: 'OWN-' + randomUUID(), creatorId: 'alice', version: 1, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' });
const path = (value: string, excluded = false) => ({ repositoryId: 'R1', path: value, excluded });
async function fixture() {
  const store = new Store({ path: ':memory:' }); initializeOwners(store.database);
  const provision = createAuth({ database: store.database, mode: 'local', provisioning: true, basePath: '/' });
  const alice = await provision.createAccount({ username: 'alice', displayName: 'Alice', password: 'Owners fixture password Alice' });
  const bob = await provision.createAccount({ username: 'bob', displayName: 'Bob', password: 'Owners fixture password Bob' });
  const charlie = await provision.createAccount({ username: 'charlie', displayName: 'Charlie', password: 'Owners fixture password Charlie' });
  const auth = createAuth({ database: store.database, mode: 'password', basePath: '/' }), policies = new PolicyStore(store.database, { principalExists: id => !!store.database.prepare('SELECT 1 FROM auth_accounts WHERE id=? AND disabled=0').get(id) }), service = new OwnersService(store, auth, policies);
  store.createRepository({ name: 'Compiler', remoteUrl: 'https://example.invalid/compiler.git' });
  store.createRepository({ name: 'Private runtime', remoteUrl: 'https://example.invalid/runtime.git' });
  const tokens = { alice: auth.createToken(alice.id, { name: 'Alice', scopes: ['read', 'write'] }), bob: auth.createToken(bob.id, { name: 'Bob', scopes: ['read', 'write'] }), charlie: auth.createToken(charlie.id, { name: 'Charlie', scopes: ['read', 'write'] }), reader: auth.createToken(alice.id, { name: 'Read only', scopes: ['read'] }) };
  const actors = Object.fromEntries(Object.entries(tokens).map(([name, credential]) => [name, auth.authenticate({ headers: { authorization: 'Bearer ' + credential.token }, method: 'GET' } as IncomingMessage)])) as Record<keyof typeof tokens, ReturnType<typeof auth.authenticate>>;
  const epoch = () => policies.epoch(), input = (patch: Partial<OwnersDefinition> = {}) => ({ ...definition(patch), expectedAccessEpoch: epoch() });
  const mutate = (url: string, data: unknown, who: keyof typeof actors = 'alice', key = randomUUID(), method = url === '/api/owners' ? 'POST' : 'PUT') => service.mutate(method, url, data, key, actors[who]).body as OwnersReceipt;
  const read = <T,>(url: string, who: keyof typeof actors = 'alice', query = new URLSearchParams()) => service.read(url, query, actors[who]) as T;
  const setPolicy = (id: string, view: string[] | null, edit: string[] | null = view) => {
    const before = policies.policy(id, alice.id), audience = (ids: string[] | null) => ids === null ? { kind: 'workspace' as const } : { kind: 'principals' as const, principalIds: ids };
    policies.setPolicy(id, { expectedVersion: before.version, spaceId: before.spaceId, view: audience(view), edit: audience(edit), interact: audience(view) }, alice.id);
  };
  const resolve = (paths: string[], who: keyof typeof actors = 'alice', repositoryId = 'R1') => read<OwnersResolve>('/api/owners/resolve', who, new URLSearchParams({ repositoryId, paths: JSON.stringify(paths) }));
  return { store, auth, policies, service, alice, bob, charlie, actors, tokens, epoch, input, mutate, read, resolve, setPolicy, close: () => store.close() };
}

test('Owners definitions canonicalize component paths and reject ambiguous claims and unsupported blocking', () => {
  assert.equal(ownersPath('src///lexer/'), '/src/lexer'); assert.equal(ownersPath('/'), '/');
  assert.deepEqual(parseOwnersDefinition(definition()), definition());
  for (const value of ['', '../a', '/src/../secret', '/src/./a', '/a\nb', '/a\0b']) assert.throws(() => ownersPath(value));
  for (const value of [definition({ paths: [path('/src'), path('src/', true)] }), definition({ owners: [{ kind: 'person', id: 'alice' }, { kind: 'person', id: 'alice' }] }), definition({ autoReview: 'block' as 'review' }), definition({ autoReview: 'block-always' as 'review' }), definition({ visibility: 'public' as 'workspace' }), definition({ auditing: 'unknown' as 'none' }), definition({ owners: [{ kind: 'project', id: 'not-a-project' }] }), { ...definition(), arbitrary: 'ignored?' }]) assert.throws(() => parseOwnersDefinition(value));
  assert.throws(() => parseOwnersWrite({ ...definition(), expectedVersion: 1, expectedAccessEpoch: 1 }, false));
  assert.throws(() => parseOwnersWrite({ ...definition(), expectedAccessEpoch: 1 }, true));
  assert.equal(parseOwnersDefinition(definition({ name: '🦄 Compiler' })).name, '🦄 Compiler');
});

test('Owners path matching uses literal boundaries, longest exclusion/reinclusion, repository identity and archive state', () => {
  const root = pkg('Root', { paths: [path('/'), path('/vendor', true), path('/vendor/local'), path('/vendor/local/test', true)] });
  const exact = pkg('Exact', { paths: [path('/src')] });
  const archived = pkg('Archived', { status: 'archived', paths: [path('/')] });
  const otherRepo = pkg('Other repository', { paths: [{ ...path('/'), repositoryId: 'R2' }] });
  const result = matchOwners([root, exact, archived, otherRepo], 'R1', ['/src', 'src/a.ts', '/src-other/a', '/vendor/lib', '/vendor/local/a', '/vendor/local/test/a', '/vendorish/a']);
  assert.deepEqual(result.map(item => [item.package.name, item.paths]), [['Exact', ['/src', '/src/a.ts']], ['Root', ['/src', '/src/a.ts', '/src-other/a', '/vendor/local/a', '/vendorish/a']]]);
  assert.deepEqual(matchOwners([root], 'R2', ['/src']), []);
  assert.deepEqual(matchOwners([pkg('Literal', { paths: [path('/src/*')] })], 'R1', ['/src/a']), []);
  const unusual = ['src/new\nline', 'src/tab\tfile', 'src/ leading space', 'src/' + 'a'.repeat(5000)];
  assert.deepEqual(matchOwners([root], 'R1', unusual)[0]!.paths, unusual.map(value => '/' + value));
});

test('Owners strong and weak dominion agree with every upstream equal-path combination and more-specific claims', () => {
  for (let mask = 0; mask < 8; mask++) {
    const packages = [0, 1, 2].map(index => pkg('Package ' + index, { dominion: mask & (1 << index) ? 'strong' : 'weak' }));
    const expected = packages.filter(value => !mask || value.dominion === 'strong').map(value => value.id).sort();
    assert.deepEqual(matchOwners(packages, 'R1', ['/src/x']).map(value => value.package.id).sort(), expected);
  }
  const weakRoot = pkg('Weak root', { dominion: 'weak', paths: [path('/')] }), weakChild = pkg('Weak child', { dominion: 'weak', paths: [path('/src')] }), strongRoot = pkg('Strong root', { paths: [path('/')] });
  assert.deepEqual(matchOwners([weakRoot, weakChild], 'R1', ['/src/x']).map(value => value.package.name), ['Weak child']);
  assert.deepEqual(matchOwners([strongRoot, weakChild], 'R1', ['/src/x']).map(value => value.package.name), ['Strong root', 'Weak child']);
  assert.deepEqual(matchOwners([weakRoot, pkg('Excluded child', { paths: [path('/src', true)] })], 'R1', ['/src/x']).map(value => value.package.name), ['Weak root']);
});

test('Owners private access and editing are bounded by current people, project membership and every repository', async () => {
  const f = await fixture();
  try {
    const created = f.mutate('/api/owners', f.input({ owners: [{ kind: 'person', id: f.bob.id }] })).package!, url = '/api/owners/' + created.id;
    assert.equal(f.read<OwnersDetail>(url, 'bob').canEdit, true);
    assert.throws(() => f.read(url, 'charlie'), status(404));
    assert.throws(() => f.mutate(url, { ...f.input(), expectedVersion: 1 }, 'charlie'), status(404));
    assert.equal(f.read<OwnersList>('/api/owners', 'reader').canCreate, false);
    assert.throws(() => f.mutate('/api/owners', f.input(), 'reader'), status(403));
    f.setPolicy('R1', null, [f.alice.id]);
    assert.equal(f.read<OwnersDetail>(url, 'bob').canEdit, false);
    assert.throws(() => f.mutate(url, { ...f.input(), expectedVersion: 1 }, 'bob'), status(403));
    assert.throws(() => f.mutate('/api/owners', f.input(), 'bob'), status(403));
    f.setPolicy('R2', [f.alice.id]);
    const second = f.mutate('/api/owners', f.input({ visibility: 'workspace', paths: [path('/src'), { ...path('/lib'), repositoryId: 'R2' }] })).package!;
    assert.throws(() => f.read('/api/owners/' + second.id, 'bob'), status(404));
    assert.equal(f.resolve(['/src/file'], 'bob').matches.some(value => value.package.id === second.id), false);
    assert.throws(() => f.resolve(['/lib/file'], 'bob', 'R2'), status(404));
    const project = f.store.createProject({ name: 'Compiler team', memberIds: [f.bob.id] });
    const team = f.mutate('/api/owners', f.input({ owners: [{ kind: 'project', id: project.id }] })).package!;
    assert.deepEqual(f.service.packages.resolvedOwners(team), [f.bob.id]); assert.equal(f.read<OwnersDetail>('/api/owners/' + team.id, 'bob').package.id, team.id);
    f.store.updateProjectMembers(project.id, { action: 'remove', principalIds: [f.bob.id], expectedCollectionVersion: f.store.projectMembers(project.id, f.alice.id).collectionVersion });
    assert.throws(() => f.read('/api/owners/' + team.id, 'bob'), status(404));
  } finally { f.close(); }
});

test('Owners disabled project members are excluded and hidden owner projects ceiling shared package access', async () => {
  const f = await fixture();
  try {
    const project = f.store.createProject({ name: 'Private team', memberIds: [f.bob.id] });
    const created = f.mutate('/api/owners', f.input({ visibility: 'workspace', owners: [{ kind: 'project', id: project.id }] })).package!;
    assert.ok(f.read<OwnersDetail>('/api/owners/' + created.id, 'charlie'));
    f.setPolicy(project.id, [f.alice.id, f.bob.id]);
    assert.throws(() => f.read('/api/owners/' + created.id, 'charlie'), status(404));
    assert.equal(f.read<OwnersList>('/api/owners', 'charlie').packages.length, 0);
    f.store.database.prepare('UPDATE auth_accounts SET disabled=1 WHERE id=?').run(f.bob.id);
    assert.deepEqual(f.service.packages.resolvedOwners(created), []);
  } finally { f.close(); }
});

test('Owners matching resolves hidden strong claims before projecting and suspends revoked configuring authority', async () => {
  const f = await fixture();
  try {
    const weak = f.mutate('/api/owners', f.input({ name: 'Visible weak', visibility: 'workspace', dominion: 'weak' })).package!;
    const strong = f.mutate('/api/owners', f.input({ name: 'Private strong' })).package!;
    assert.deepEqual(f.resolve(['/src/file'], 'charlie').matches, []);
    assert.deepEqual(f.resolve(['/src/file']).matches.map(value => value.package.id), [strong.id]);
    f.mutate('/api/owners/' + strong.id, { ...f.input({ name: 'Private strong', status: 'archived' }), expectedVersion: 1 });
    assert.deepEqual(f.resolve(['/src/file'], 'charlie').matches.map(value => value.package.id), [weak.id]);
    const before = f.policies.policy('R1', f.alice.id);
    f.policies.setPolicy('R1', { expectedVersion: before.version, spaceId: before.spaceId, view: { kind: 'workspace' }, edit: { kind: 'principals', principalIds: [f.bob.id] }, interact: { kind: 'workspace' } }, f.bob.id);
    assert.deepEqual(f.resolve(['/src/file'], 'charlie').matches, []);
    assert.equal(f.read<OwnersList>('/api/owners', 'charlie').packages[0]!.id, weak.id, 'suspended routing preserves the visible definition');
  } finally { f.close(); }
});

test('Owners mutations pin exact versions and access, retry without overwrites, archive and restore with immutable history', async () => {
  const f = await fixture();
  try {
    const key = randomUUID(), original = f.input(), created = f.mutate('/api/owners', original, 'alice', key), id = created.package!.id, url = '/api/owners/' + id;
    assert.ok(validOwnersReceipt(created, '/api/owners', 'POST', original));
    assert.equal(f.mutate('/api/owners', original, 'alice', key).receipt.replayed, true);
    assert.throws(() => f.mutate('/api/owners', f.input({ name: 'Changed replay' }), 'alice', key), status(409));
    f.mutate(url, { ...f.input({ name: 'New package name', visibility: 'workspace' }), expectedVersion: 1 });
    const replayed = f.mutate('/api/owners', original, 'alice', key);
    assert.equal(replayed.receipt.version, 1); assert.equal(replayed.package!.version, 2); assert.equal(replayed.package!.name, 'New package name');
    assert.ok(validOwnersReceipt(replayed, '/api/owners', 'POST', original));
    assert.throws(() => f.mutate(url, { ...f.input(), expectedVersion: 1 }), status(409));
    assert.throws(() => f.mutate(url, { ...f.input(), expectedAccessEpoch: f.epoch() - 1, expectedVersion: 2 }), status(409));
    const archived = f.mutate(url, { ...f.input({ status: 'archived' }), expectedVersion: 2 }).package!;
    assert.equal(archived.status, 'archived'); assert.deepEqual(f.resolve(['/src/file']).matches, []);
    const restored = f.mutate(url, { ...f.input(), expectedVersion: 3 }).package!;
    assert.equal(restored.status, 'active'); assert.equal(f.resolve(['/src/file']).matches[0]!.package.version, 4);
    assert.deepEqual(f.read<OwnersHistory>(url + '/history').history.map(entry => entry.package.version), [4, 3, 2, 1]);
    assert.deepEqual(f.service.packages.snapshot(id, 1), created.package);
    assert.throws(() => f.store.database.prepare('DELETE FROM owners_packages WHERE id=?').run(id), /archived/);
    assert.throws(() => f.store.database.prepare('UPDATE owners_history SET actor_name=?').run('Forged'), /immutable/);
    assert.throws(() => f.store.database.prepare('DELETE FROM owners_operations').run(), /immutable/);
    assert.equal(validOwnersReceipt({ ...created, receipt: { ...created.receipt, version: 77 } }, '/api/owners', 'POST', original), false);
    assert.equal(ownersDefinition(restored).name, restored.name);
  } finally { f.close(); }
});

test('Owners exact replay can acknowledge a lost-access update without returning protected content', async () => {
  const f = await fixture();
  try {
    const created = f.mutate('/api/owners', f.input({ owners: [{ kind: 'person', id: f.bob.id }] })).package!, url = '/api/owners/' + created.id;
    const input = { ...f.input(), expectedVersion: 1 }, key = randomUUID();
    const updated = f.mutate(url, input, 'bob', key); assert.equal(updated.package, null); assert.equal(updated.receipt.version, 2);
    assert.ok(validOwnersReceipt(updated, url, 'PUT', input));
    const replay = f.mutate(url, input, 'bob', key); assert.equal(replay.receipt.replayed, true); assert.equal(replay.package, null);
    assert.deepEqual(f.service.packages.active(), [], 'a configuring owner who removed themselves cannot retain routing authority');
    assert.throws(() => f.read(url, 'bob'), status(404));
    f.auth.revokeToken(f.bob.id, f.tokens.bob.record.id);
    assert.throws(() => f.mutate(url, input, 'bob', key), status(401));
    assert.throws(() => f.read('/api/owners', 'bob'), status(401));
  } finally { f.close(); }
});

test('Owners histories enforce both current and historical visibility and dependency ceilings', async () => {
  const f = await fixture();
  try {
    const created = f.mutate('/api/owners', f.input({ name: 'Earlier private title', paths: [{ ...path('/'), repositoryId: 'R2' }] })).package!, url = '/api/owners/' + created.id;
    f.mutate(url, { ...f.input({ name: 'Shared current title', visibility: 'workspace' }), expectedVersion: 1 });
    const history = f.read<OwnersHistory>(url + '/history', 'charlie'); assert.deepEqual(history.history.map(entry => entry.package.version), [2]);
    assert.equal(JSON.stringify(history).includes('Earlier private title'), false);
    assert.equal(f.read<OwnersHistory>(url + '/history').history.length, 2);
    f.setPolicy('R2', [f.bob.id, f.alice.id]);
    const shared = f.mutate('/api/owners', f.input({ visibility: 'workspace', paths: [{ ...path('/'), repositoryId: 'R2' }] })).package!;
    f.mutate('/api/owners/' + shared.id, { ...f.input({ visibility: 'workspace' }), expectedVersion: 1 });
    assert.deepEqual(f.read<OwnersHistory>('/api/owners/' + shared.id + '/history', 'charlie').history.map(entry => entry.package.version), [2]);
  } finally { f.close(); }
});

test('Owners package, history and exact receipt commit together or roll back on failure', async () => {
  const f = await fixture();
  try {
    f.store.database.exec("CREATE TRIGGER fail_owners_receipt BEFORE INSERT ON owners_operations BEGIN SELECT RAISE(ABORT,'Injected receipt failure'); END");
    const beforeEpoch = f.epoch(); assert.throws(() => f.mutate('/api/owners', f.input()), /Injected receipt failure/);
    for (const table of ['owners_packages', 'owners_history', 'owners_operations']) assert.equal(f.store.database.prepare('SELECT count(*) AS n FROM ' + table).get()!.n, 0);
    assert.equal(f.epoch(), beforeEpoch);
    f.store.database.exec('DROP TRIGGER fail_owners_receipt');
    const created = f.mutate('/api/owners', f.input()).package!;
    f.store.database.exec("CREATE TRIGGER fail_owners_receipt BEFORE INSERT ON owners_operations BEGIN SELECT RAISE(ABORT,'Injected receipt failure'); END");
    assert.throws(() => f.mutate('/api/owners/' + created.id, { ...f.input({ visibility: 'workspace' }), expectedVersion: 1 }), /Injected receipt failure/);
    assert.deepEqual(f.service.packages.get(created.id, f.alice.id), created); assert.equal(f.epoch(), beforeEpoch);
    assert.equal(f.read<OwnersHistory>('/api/owners/' + created.id + '/history').history.length, 1);
  } finally { f.close(); }
});

test('Owners validates read parameters, missing request IDs and methods without creating anything', async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.service.mutate('POST', '/api/owners', f.input(), undefined, f.actors.alice), status(400));
    assert.throws(() => f.mutate('/api/owners', f.input(), 'alice', randomUUID(), 'DELETE'), status(405));
    assert.throws(() => f.read('/api/owners', 'alice', new URLSearchParams({ extra: 'hidden' })), status(400));
    for (const query of [new URLSearchParams('repositoryId=R1&repositoryId=R2&paths=[]'), new URLSearchParams({ repositoryId: 'R1', paths: '[]' }), new URLSearchParams({ repositoryId: 'R1', paths: '["../secret"]' }), new URLSearchParams({ repositoryId: 'R1', paths: '{}' })]) assert.throws(() => f.read('/api/owners/resolve', 'alice', query), status(400));
    assert.equal(f.read<OwnersList>('/api/owners').packages.length, 0);
  } finally { f.close(); }
});

test('Owners initializer is repeatable and incompatible schema collisions roll back every created object', () => {
  for (const collision of ['owners_packages', 'owners_history', 'owners_operations']) {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('CREATE TABLE ' + collision + "(operator_text TEXT); INSERT INTO " + collision + " VALUES('Preserve this')");
      assert.throws(() => initializeOwners(db), new RegExp('Unexpected ' + collision));
      assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'owners_%' ORDER BY name").all().map(row => row.name), [collision]);
      assert.equal(db.prepare('SELECT operator_text FROM ' + collision).get()!.operator_text, 'Preserve this');
      db.exec('DROP TABLE ' + collision); initializeOwners(db); initializeOwners(db);
      assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'owners_%'").get()!.n, 9);
    } finally { db.close(); }
  }
});
