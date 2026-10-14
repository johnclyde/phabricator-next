import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { createAuth } from './auth.ts';
import { PolicyStore } from './policy.ts';
import { Store } from './store.ts';
import { DashboardService } from './dashboard-routes.ts';
import { initializeDashboards } from './dashboards.ts';
import { parseDashboardDefinition, parseDashboardHome, parseDashboardWrite, type DashboardDefinition, type DashboardHomeDetail, type DashboardList, type DashboardReceipt } from '../shared/dashboards.ts';
import { emptySearchQuery } from '../shared/search.ts';

const status = (expected: number) => (error: unknown) => !!error && typeof error === 'object' && 'status' in error && error.status === expected;
const definition = (patch: Partial<DashboardDefinition> = {}): DashboardDefinition => ({ name: 'Research home', description: 'Current work', visibility: 'private', layout: 'equal', panels: [{ id: 'notes', title: 'Notes', column: 0, kind: 'text', text: '**Private research**' }, { id: 'tasks', title: 'Open tasks', column: 1, kind: 'query', query: { ...emptySearchQuery(), kinds: ['task'], statuses: ['open'] }, limit: 10 }], ...patch });
async function fixture() {
  const store = new Store({ path: ':memory:' }), provision = createAuth({ database: store.database, mode: 'local', provisioning: true, basePath: '/' });
  const alice = await provision.createAccount({ username: 'alice', displayName: 'Alice', password: 'Dashboard test only password' });
  const bob = await provision.createAccount({ username: 'bob', displayName: 'Bob', password: 'Dashboard test only password' });
  const auth = createAuth({ database: store.database, mode: 'password', basePath: '/' }), policies = new PolicyStore(store.database, { principalExists: id => id === alice.id || id === bob.id }), service = new DashboardService(store, auth, policies);
  const token = (id: string, write = true) => auth.createToken(id, { name: 'Dashboard test', scopes: write ? ['read', 'write'] : ['read'] });
  const tokens = { alice: token(alice.id), bob: token(bob.id), reader: token(alice.id, false) };
  const actors = Object.fromEntries(Object.entries(tokens).map(([name, credential]) => [name, auth.authenticate({ headers: { authorization: `Bearer ${credential.token}` }, method: 'GET' } as IncomingMessage)])) as Record<keyof typeof tokens, ReturnType<typeof auth.authenticate>>;
  const epoch = () => policies.epoch();
  const input = (patch: Partial<DashboardDefinition> = {}) => ({ ...definition(patch), expectedAccessEpoch: epoch() });
  const mutate = (path: string, data: unknown, who: keyof typeof actors = 'alice', key = randomUUID(), method = path.match(/^\/api\/dashboards\/DASH-[a-f0-9-]+$/) ? 'PUT' : 'POST') => service.mutate(method, path, data, key, actors[who]).body as DashboardReceipt;
  const read = <T,>(path: string, who: keyof typeof actors = 'alice') => service.read(path, new URLSearchParams(), actors[who]) as T;
  return { store, service, policies, tokens, actors, epoch, input, mutate, read, close: () => store.close() };
}

test('dashboard definitions accept supported layouts and reject ambiguous or unsafe panel inputs', () => {
  assert.deepEqual(parseDashboardDefinition(definition()), definition());
  for (const value of [definition({ layout: 'unknown' as 'equal' }), definition({ panels: [definition().panels[0]!, definition().panels[0]!] }), definition({ layout: 'single' }), definition({ name: '' }), definition({ visibility: 'public' as 'private' }), { ...definition(), ownerId: 'injected' }, definition({ panels: [{ id: 'bad', title: 'Bad', kind: 'query', column: 0, query: { ...emptySearchQuery(), text: '"unclosed' }, limit: 10 }] }), definition({ panels: [{ id: 'bad', title: 'Bad', kind: 'query', column: 0, query: emptySearchQuery(), limit: 0 }] })]) assert.throws(() => parseDashboardDefinition(value));
  assert.throws(() => parseDashboardWrite({ ...definition(), expectedVersion: 1, expectedAccessEpoch: 0 }, false));
  assert.throws(() => parseDashboardHome({ dashboardId: null, version: -1, expectedAccessEpoch: 0 }));
  const simple = definition({ layout: 'single', panels: [{ id: 'unicode', title: '🤖 Review', column: 0, kind: 'text', text: 'A real Unicode title.' }] });
  assert.equal(parseDashboardDefinition(simple).panels[0]!.title, '🤖 Review');
});

test('dashboard sharing is explicit, edits belong to owners, and withdrawn dashboards retire other users home choices', async () => {
  const f = await fixture();
  try {
    const created = f.mutate('/api/dashboards', f.input()), id = created.dashboard!.id;
    assert.deepEqual(f.read<DashboardList>('/api/dashboards', 'bob').dashboards, []);
    assert.throws(() => f.read(`/api/dashboards/${id}`, 'bob'), status(404));
    assert.throws(() => f.mutate(`/api/dashboards/${id}`, null, 'bob'), status(404));
    assert.throws(() => f.mutate('/api/dashboard-home', { dashboardId: id, version: 0, expectedAccessEpoch: f.epoch() }, 'bob'), status(404));
    assert.throws(() => f.mutate('/api/dashboards', f.input(), 'reader'), status(403));
    const shared = f.mutate(`/api/dashboards/${id}`, { ...f.input({ visibility: 'workspace' }), expectedVersion: 1 });
    assert.equal(shared.dashboard!.version, 2);
    assert.equal(f.read<DashboardList>('/api/dashboards', 'bob').dashboards[0]!.id, id);
    assert.throws(() => f.mutate(`/api/dashboards/${id}`, { ...f.input(), expectedVersion: 2 }, 'bob'), status(404));
    const home = f.mutate('/api/dashboard-home', { dashboardId: id, version: 0, expectedAccessEpoch: f.epoch() }, 'bob');
    assert.equal(home.home.dashboardId, id); assert.equal(home.home.version, 1);
    assert.equal(f.read<DashboardHomeDetail>('/api/dashboard-home', 'bob').dashboard!.id, id);
    const before = f.epoch();
    f.mutate(`/api/dashboards/${id}`, { ...f.input(), expectedVersion: 2 });
    assert.ok(f.epoch() > before);
    const revoked = f.read<DashboardHomeDetail>('/api/dashboard-home', 'bob');
    assert.equal(revoked.dashboard, null); assert.deepEqual(revoked.home, { dashboardId: null, version: 1 });
    assert.doesNotMatch(JSON.stringify(revoked), new RegExp(id));
    assert.throws(() => f.read(`/api/dashboards/${id}`, 'bob'), status(404));
  } finally { f.close(); }
});

test('dashboard writes pin versions and access, retry exactly, survive later changes and never resurrect tombstones', async () => {
  const f = await fixture();
  try {
    const key = randomUUID(), originalInput = f.input(), first = f.mutate('/api/dashboards', originalInput, 'alice', key), id = first.dashboard!.id;
    const retried = f.mutate('/api/dashboards', originalInput, 'alice', key);
    assert.equal(retried.receipt.replayed, true); assert.deepEqual(retried.dashboard, first.dashboard);
    assert.throws(() => f.mutate('/api/dashboards', f.input({ name: 'Changed key payload' }), 'alice', key), status(409));
    const edited = f.mutate(`/api/dashboards/${id}`, { ...f.input({ name: 'Changed dashboard' }), expectedVersion: 1 });
    assert.equal(edited.dashboard!.version, 2);
    assert.throws(() => f.mutate(`/api/dashboards/${id}`, { ...f.input({ name: 'Lost update' }), expectedVersion: 1 }), status(409));
    assert.throws(() => f.mutate(`/api/dashboards/${id}`, { ...f.input(), expectedAccessEpoch: f.epoch() + 1, expectedVersion: 2 }), status(409));
    const receipt = f.mutate('/api/dashboards', originalInput, 'alice', key);
    assert.equal(receipt.receipt.version, 1); assert.equal(receipt.dashboard!.version, 2); assert.equal(receipt.dashboard!.name, 'Changed dashboard');
    const deleteKey = randomUUID(), deleteInput = { expectedVersion: 2, expectedAccessEpoch: f.epoch() };
    const deleted = f.mutate(`/api/dashboards/${id}/delete`, deleteInput, 'alice', deleteKey);
    assert.equal(deleted.dashboard, null); assert.equal(deleted.receipt.version, 3);
    assert.equal(f.mutate(`/api/dashboards/${id}/delete`, deleteInput, 'alice', deleteKey).receipt.replayed, true);
    assert.equal(f.mutate('/api/dashboards', originalInput, 'alice', key).dashboard, null);
    assert.throws(() => f.mutate(`/api/dashboards/${id}`, { ...f.input(), expectedVersion: 3 }), status(404));
    assert.deepEqual(f.read<DashboardList>('/api/dashboards').dashboards, []);
    assert.throws(() => f.store.database.prepare('DELETE FROM dashboard_records WHERE id=?').run(id), /tombstones/);
    assert.throws(() => f.store.database.prepare('UPDATE dashboard_history SET snapshot=?').run('{}'), /immutable/);
    assert.throws(() => f.store.database.prepare('DELETE FROM dashboard_operations').run(), /immutable/);
  } finally { f.close(); }
});

test('home preferences are independent per principal, concurrency-safe and exact retries never restore an older choice', async () => {
  const f = await fixture();
  try {
    const first = f.mutate('/api/dashboards', f.input({ visibility: 'workspace' })).dashboard!, second = f.mutate('/api/dashboards', f.input({ name: 'Another', visibility: 'workspace' })).dashboard!;
    const key = randomUUID(), input = { dashboardId: first.id, version: 0, expectedAccessEpoch: f.epoch() };
    f.mutate('/api/dashboard-home', input, 'alice', key);
    f.mutate('/api/dashboard-home', { dashboardId: second.id, version: 1, expectedAccessEpoch: f.epoch() });
    assert.throws(() => f.mutate('/api/dashboard-home', { dashboardId: null, version: 1, expectedAccessEpoch: f.epoch() }), status(409));
    const retried = f.mutate('/api/dashboard-home', input, 'alice', key);
    assert.equal(retried.receipt.version, 1); assert.equal(retried.home.version, 2); assert.equal(retried.home.dashboardId, second.id);
    assert.deepEqual(f.read<DashboardHomeDetail>('/api/dashboard-home', 'bob').home, { dashboardId: null, version: 0 });
    f.mutate('/api/dashboard-home', { dashboardId: first.id, version: 0, expectedAccessEpoch: f.epoch() }, 'bob');
    f.mutate(`/api/dashboards/${first.id}/delete`, { expectedVersion: 1, expectedAccessEpoch: f.epoch() });
    assert.equal(f.read<DashboardHomeDetail>('/api/dashboard-home', 'bob').dashboard, null);
    assert.equal(f.read<DashboardHomeDetail>('/api/dashboard-home').dashboard!.id, second.id);
    f.store.database.prepare('UPDATE auth_tokens SET revoked=1 WHERE id=?').run(f.tokens.alice.record.id);
    assert.throws(() => f.mutate('/api/dashboard-home', input, 'alice', key), status(401));
    assert.throws(() => f.read('/api/dashboards'), status(401));
  } finally { f.close(); }
});

test('dashboard initialization is repeatable and rejects partial incompatible schemas atomically', () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec('CREATE TABLE dashboard_history(wrong TEXT)');
    assert.throws(() => initializeDashboards(database), /Unexpected dashboard_history/);
    assert.equal(database.prepare("SELECT 1 FROM sqlite_master WHERE name='dashboard_records'").get(), undefined);
    database.exec('DROP TABLE dashboard_history'); initializeDashboards(database); initializeDashboards(database);
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'dashboard_%'").get()!.n, 10);
  } finally { database.close(); }
});
