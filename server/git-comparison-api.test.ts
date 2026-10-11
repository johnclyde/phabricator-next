import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from './app.ts';
import { createAuth } from './auth.ts';
import { createStore } from './store.ts';
import type { GitObserver } from './git.ts';
import { HttpError } from './validation.ts';
import type { GitCommit, GitComparison, GitComparisonFile, GitComparisonFileQuery, GitComparisonQuery } from '../shared/repositories.ts';
import type { SessionState } from '../shared/auth.ts';
import { createGitFixture, createGitComparisonFixture } from '../tests/git-fixture.ts';

const base = 'a'.repeat(40), target = 'b'.repeat(40);
const person = { name: 'Comparison author', email: 'compare@example.test', timestamp: '2026-01-01T00:00:00.000Z' };
const commit = (id: string, treeId: string, parentIds: string[] = []): GitCommit => ({ id, treeId, parentIds, author: person, committer: person, message: 'Exact source', messageTruncated: false });
const baseCommit = commit(base, 'c'.repeat(40));
const targetCommit = commit(target, 'd'.repeat(40), [base]);
const pair = { repositoryId: 'R1', objectFormat: 'sha1' as const, baseCommit, targetCommit, baseTreeId: baseCommit.treeId, targetTreeId: targetCommit.treeId };
const change = { id: 'e'.repeat(64), status: 'modified' as const, similarity: null, before: { path: 'a b/研究.md', objectId: 'f'.repeat(40), mode: '100644', type: 'file' as const, size: 6 }, after: { path: 'a b/研究.md', objectId: '1'.repeat(40), mode: '100644', type: 'file' as const, size: 7 } };
const inventory: GitComparison = { ...pair, algorithm: 'git-M50-C50', changes: [change] };
const file: GitComparisonFile = { ...pair, change, before: { repositoryId: 'R1', objectFormat: 'sha1', commitId: base, path: change.before.path, objectId: change.before.objectId, mode: '100644', state: 'text', content: 'before', size: 6 }, after: { repositoryId: 'R1', objectFormat: 'sha1', commitId: target, path: change.after.path, objectId: change.after.objectId, mode: '100644', state: 'text', content: 'PRIVATE', size: 7 } };
const route = `/api/repositories/R1/compare?base=${base}&target=${target}`;
const fileRoute = `/api/repositories/R1/compare/file?base=${base}&target=${target}&beforePath=${encodeURIComponent(change.before.path)}&afterPath=${encodeURIComponent(change.after.path)}`;
const members = (...principalIds: string[]) => ({ kind: 'principals' as const, principalIds });
const workspace = { kind: 'workspace' as const };
type ErrorBody = { error: string; code?: string };

function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function observer(overrides: Partial<GitObserver> = {}): GitObserver {
  const unavailable = async (): Promise<never> => { throw new HttpError(503, 'Fixture read is unavailable.', 'GIT_UNAVAILABLE'); };
  return { info: async () => ({ state: 'ready', objectFormat: 'sha1' }), refs: unavailable, commit: unavailable, tree: unavailable, blob: unavailable, history: unavailable, importSnapshot: unavailable, compare: async () => inventory, compareFile: async () => file, ...overrides };
}
async function start(options: { observer?: GitObserver; password?: boolean; basePath?: string; barePath?: string } = {}) {
  const store = createStore({ path: ':memory:' });
  const basePath = options.basePath ?? '/';
  const provision = createAuth({ database: store.database, mode: 'local', basePath, provisioning: true });
  const alice = options.password ? await provision.createAccount({ username: 'alice', displayName: 'Alice', password: 'Alice exact comparison password' }) : undefined;
  const bob = options.password ? await provision.createAccount({ username: 'bob', displayName: 'Bob', password: 'Bob exact comparison password' }) : undefined;
  const app = createApp({ store, seed: false, basePath, authMode: options.password ? 'password' : 'local', ...(options.barePath ? { gitRepositories: { R1: options.barePath } } : { gitObserver: options.observer ?? observer() }) });
  const token = bob ? app.auth.createToken(bob.id, { name: 'Read comparisons', scopes: ['read'] }) : undefined;
  store.createRepository({ name: 'Comparison source', remoteUrl: 'https://example.invalid/no-network.git' });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const url = (path: string) => origin + basePath.slice(0, -1) + path;
  async function request<T = ErrorBody>(path: string, bearer = token?.token) {
    const response = await fetch(url(path), { signal: AbortSignal.timeout(15_000), headers: bearer ? { Authorization: `Bearer ${bearer}` } : {} });
    return { status: response.status, body: await response.json() as T, headers: response.headers };
  }
  function policy(fields: Record<string, unknown>) {
    const old = app.policies.policy('R1', alice!.id);
    return app.policies.setPolicy('R1', { expectedVersion: old.version, spaceId: old.spaceId, ...old.rules, ...fields }, alice!.id);
  }
  let closed = false;
  return { ...app, alice, bob, token, origin, url, request, policy, close: async () => { if (closed) return; closed = true; await app.close(); store.close(); } };
}

for (const [objectFormat, basePath] of [['sha1', '/'], ['sha256', '/phabricator/']] as const) test(`HTTP comparison retains exact ${objectFormat} pairs and literal changed files at ${basePath}`, async () => {
  const fixture = await createGitFixture(objectFormat);
  const app = await start({ barePath: fixture.barePath, basePath });
  try {
    const path = `/api/repositories/R1/compare?base=${fixture.importCommit}&target=${fixture.importNextCommit}`;
    const result = await app.request<GitComparison>(path);
    assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.objectFormat, objectFormat);
    assert.equal(result.body.baseCommit?.id, fixture.importCommit); assert.equal(result.body.targetCommit.id, fixture.importNextCommit);
    assert.equal(result.body.algorithm, 'git-M50-C50'); assert.equal(result.body.accessEpoch, app.policies.epoch()); assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.deepEqual(result.body.changes.map(item => item.after?.path ?? item.before?.path).sort(), ['README.md', 'added.md', 'name with spaces.md', 'tools', 'tools/check.sh'].sort());
    for (const changed of result.body.changes) {
      const query = new URLSearchParams({ base: fixture.importCommit, target: fixture.importNextCommit });
      if (changed.before) query.set('beforePath', changed.before.path); if (changed.after) query.set('afterPath', changed.after.path);
      const selected = await app.request<GitComparisonFile>(`/api/repositories/R1/compare/file?${query}`);
      assert.equal(selected.status, 200, JSON.stringify(selected.body)); assert.deepEqual(selected.body.change, changed);
      assert.equal(selected.body.baseCommit?.id, fixture.importCommit); assert.equal(selected.body.targetCommit.id, fixture.importNextCommit);
      assert.equal(selected.body.before?.commitId ?? null, changed.before ? fixture.importCommit : null);
      assert.equal(selected.body.after?.commitId ?? null, changed.after ? fixture.importNextCommit : null);
      assert.equal(selected.headers.get('cache-control'), 'no-store'); assert.equal(selected.body.accessEpoch, app.policies.epoch());
      if (changed.after?.path === 'tools/check.sh') { assert.equal(changed.before?.mode, '100755'); assert.equal(changed.after.mode, '100644'); assert.equal(selected.body.before?.state, 'text'); assert.equal(selected.body.after?.state, 'text'); }
      if (changed.after?.path === 'tools') { assert.equal(selected.body.before?.state, 'tree'); assert.equal(selected.body.after?.state, 'tree'); }
      assert.ok(!JSON.stringify(selected.body).includes(fixture.barePath));
    }
    await fixture.advanceMain('A branch move cannot replace either selected commit.\n');
    assert.deepEqual((await app.request<GitComparison>(path)).body, result.body);
    const reverse = await app.request<GitComparison>(`/api/repositories/R1/compare?base=${fixture.importNextCommit}&target=${fixture.importCommit}`);
    assert.equal(reverse.status, 200); assert.equal(reverse.body.changes.find(item => item.before?.path === 'added.md')?.status, 'deleted');
    const equal = await app.request<GitComparison>(`/api/repositories/R1/compare?base=${fixture.importCommit}&target=${fixture.importEqualCommit}`);
    assert.equal(equal.status, 200); assert.deepEqual(equal.body.changes, []); assert.notEqual(equal.body.baseCommit?.id, equal.body.targetCommit.id); assert.equal(equal.body.baseTreeId, equal.body.targetTreeId);
    const empty = await app.request<GitComparison>(`/api/repositories/R1/compare?base=empty&target=${fixture.base}`);
    assert.equal(empty.status, 200); assert.equal(empty.body.baseCommit, null); assert.match(empty.body.baseTreeId, new RegExp(`^[0-9a-f]{${objectFormat === 'sha1' ? 40 : 64}}$`)); assert.equal(empty.body.changes[0]?.status, 'added');
    const merge = await app.request<GitComparison>(`/api/repositories/R1/compare?base=${fixture.feature}&target=${fixture.head}`);
    assert.equal(merge.status, 200); assert.equal(merge.body.targetCommit.parentIds[1], fixture.feature); assert.ok(merge.body.changes.length > 0);
    const firstParent = await app.request<GitComparison>(`/api/repositories/R1/compare?base=${merge.body.targetCommit.parentIds[0]}&target=${fixture.head}`);
    assert.equal(firstParent.status, 200); assert.deepEqual(firstParent.body.changes, []);
    for (const paths of [{ beforePath: 'README.md', afterPath: 'added.md' }, { afterPath: 'README.md' }, { beforePath: 'docs/paper.tex', afterPath: 'docs/paper.tex' }]) {
      const query = new URLSearchParams({ base: fixture.importCommit, target: fixture.importNextCommit });
      for (const [key, value] of Object.entries(paths)) if (value !== undefined) query.set(key, value);
      const invalid = await app.request(`/api/repositories/R1/compare/file?${query}`);
      assert.equal(invalid.status, 404); assert.equal(invalid.body.code, 'GIT_OBJECT_UNAVAILABLE');
    }
    if (basePath !== '/') assert.equal((await fetch(app.origin + path)).status, 404);
  } finally { await app.close(); await fixture.close(); }
});

test('comparison query guards reject mutable IDs, duplicate parameters and ambiguous file tuples before observer access', async () => {
  let calls = 0; const failed = async (): Promise<never> => { calls++; throw new Error('unexpected Git invocation'); };
  const app = await start({ observer: observer({ compare: failed, compareFile: failed }) });
  try {
    for (const path of [
      '/compare', `/compare?base=${base}`, `/compare?target=${target}`, `/compare?base=&target=${target}`, `/compare?base=HEAD&target=${target}`, `/compare?base=empty&target=main`, `/compare?base=${base.toUpperCase()}&target=${target}`,
      `/compare?base=${base}&target=${'f'.repeat(64)}`, `/compare?base=${base}&target=${target}&target=${target}`, `/compare?base=${base}&target=${target}&base=empty`, `/compare?base=${base}&target=${target}&path=README.md`,
      `/compare/file?base=${base}&target=${target}`, `/compare/file?base=${base}&target=${target}&beforePath=`, `/compare/file?base=${base}&target=${target}&afterPath=`, `/compare/file?base=${base}&target=${target}&beforePath=a&beforePath=b`,
      ...['../private', '/etc/passwd', 'a/../b', 'a//b', 'a\u0000b'].map(value => `/compare/file?base=${base}&target=${target}&afterPath=${encodeURIComponent(value)}`),
    ]) { const result = await app.request(`/api/repositories/R1${path}`); assert.equal(result.status, 400, path); assert.equal(result.body.code, 'GIT_INVALID_QUERY', path); }
    assert.equal(calls, 0);
  } finally { await app.close(); }
});

test('real comparison HTTP preserves inferred renames, copies, type changes and every non-text state', async () => {
  const fixture = await createGitFixture(), commits = await createGitComparisonFixture(fixture), app = await start({ barePath: fixture.barePath });
  try {
    const response = await app.request<GitComparison>(`/api/repositories/R1/compare?base=${commits.base}&target=${commits.target}`);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const changes = response.body.changes, rename = changes.find(item => item.after?.path === 'rename-after.txt'), copy = changes.find(item => item.after?.path === 'copy-result.txt');
    assert.equal(rename?.status, 'renamed'); assert.equal(rename.before?.path, 'rename-before.txt'); assert.ok(rename.similarity! >= 50 && rename.similarity! < 100);
    assert.equal(copy?.status, 'copied'); assert.equal(copy.before?.path, 'copy-source.txt'); assert.equal(copy.similarity, 100);
    assert.equal(changes.find(item => item.after?.path === 'type-change')?.status, 'type_changed');
    assert.equal(changes.find(item => item.before?.path === 'to-directory' && item.after?.path === 'to-directory')?.status, 'type_changed');
    for (const [path, state] of [['rename-after.txt', 'text'], ['copy-result.txt', 'text'], ['empty-added.txt', 'text'], ['binary.dat', 'binary'], ['invalid.txt', 'unsupported_encoding'], ['oversized.txt', 'oversized'], ['module', 'submodule'], ['type-change', 'symlink'], ['to-directory', 'tree']] as const) {
      const changed = changes.find(item => item.after?.path === path); assert.ok(changed, path);
      const query = new URLSearchParams({ base: commits.base, target: commits.target, afterPath: path }); if (changed.before) query.set('beforePath', changed.before.path);
      const result = await app.request<GitComparisonFile>(`/api/repositories/R1/compare/file?${query}`);
      assert.equal(result.status, 200, JSON.stringify(result.body)); assert.deepEqual(result.body.change, changed); assert.equal(result.body.after?.state, state);
      if (path === 'empty-added.txt') { assert.equal(result.body.after?.state, 'text'); if (result.body.after?.state === 'text') assert.equal(result.body.after.content, ''); }
      if (state !== 'text') assert.ok(!Object.hasOwn(result.body.after!, 'content'), path);
      assert.ok(!JSON.stringify(result.body).includes(fixture.barePath));
    }
    const missing = await app.request(`/api/repositories/R1/compare?base=${commits.base}&target=${'0'.repeat(40)}`);
    assert.equal(missing.status, 404); assert.equal(missing.body.code, 'GIT_OBJECT_UNAVAILABLE'); assert.ok(!JSON.stringify(missing.body).includes(fixture.barePath));
    assert.equal((await app.request('/api/repositories/R1')).status, 200);
  } finally { await app.close(); await fixture.close(); }
});

test('comparison transport passes explicit empty bases and exact optional path tuples without normalizing source names', async () => {
  const queries: Array<GitComparisonQuery | GitComparisonFileQuery> = [];
  const app = await start({ observer: observer({ compare: async (_id, query) => { queries.push(query); return inventory; }, compareFile: async (_id, query) => { queries.push(query); return file; } }), basePath: '/phabricator/' });
  try {
    assert.equal((await app.request(route.replace(base, 'empty'))).status, 200);
    assert.equal((await app.request(fileRoute)).status, 200);
    assert.equal((await app.request(`/api/repositories/R1/compare/file?base=empty&target=${target}&afterPath=%EF%BB%BFfigure%20%23%25%5C.png`)).status, 200);
    assert.deepEqual(queries, [{ base: null, target }, { base, target, beforePath: change.before.path, afterPath: change.after.path }, { base: null, target, beforePath: null, afterPath: '\ufefffigure #%\\.png' }]);
  } finally { await app.close(); }
});

test('hidden or missing repositories and restricted Spaces reveal no comparison or file metadata', async () => {
  let calls = 0; const app = await start({ password: true, observer: observer({ compare: async () => { calls++; return inventory; }, compareFile: async () => { calls++; return file; } }) });
  try {
    const token = app.auth.createToken(app.bob!.id, { name: 'Write without read', scopes: ['write'] });
    assert.equal((await app.request(route, token.token)).status, 403); assert.equal((await app.request(fileRoute, token.token)).status, 403);
    app.policy({ view: members(app.alice!.id), edit: members(app.alice!.id) });
    const missing = await app.request(route.replace('R1', 'R999'));
    for (const path of [route, fileRoute, '/api/repositories/R1/compare?invalid=secret']) { const denied = await app.request(path); assert.equal(denied.status, 404); assert.deepEqual(denied.body, missing.body); }
    const space = app.policies.createSpace({ name: 'Private comparison source', view: members(app.alice!.id), edit: members(app.alice!.id) }, app.alice!.id);
    app.policy({ spaceId: space.id, view: workspace });
    assert.deepEqual((await app.request(fileRoute)).body, missing.body); assert.equal(calls, 0);
  } finally { await app.close(); }
});

test('both comparison reads reauthorize successes and failures after Git without retaining a database transaction', async () => {
  let entered = deferred<void>(), wait = deferred<GitComparison | GitComparisonFile>();
  const app = await start({ password: true, observer: observer({ compare: async () => { entered.resolve(); return await wait.promise as GitComparison; }, compareFile: async () => { entered.resolve(); return await wait.promise as GitComparisonFile; } }) });
  try {
    for (const [path, response] of [[route, inventory], [fileRoute, file]] as const) for (const failure of [false, true]) {
      app.policy({ view: workspace, edit: members(app.alice!.id) }); entered = deferred<void>(); wait = deferred<GitComparison | GitComparisonFile>();
      const pending = app.request(path); await entered.promise;
      assert.doesNotThrow(() => app.store.database.exec('BEGIN IMMEDIATE; ROLLBACK;'));
      app.policy({ view: members(app.alice!.id) });
      if (failure) wait.reject(new HttpError(404, 'PRIVATE /operator/repository missing object', 'GIT_OBJECT_UNAVAILABLE')); else wait.resolve(response);
      const denied = await pending; assert.equal(denied.status, 404); assert.equal(denied.body.code, 'OBJECT_UNAVAILABLE'); assert.ok(!JSON.stringify(denied.body).includes('PRIVATE'));
    }
    const space = app.policies.createSpace({ name: 'Shared during request', view: workspace, edit: members(app.alice!.id) }, app.alice!.id);
    app.policy({ spaceId: space.id, view: workspace }); entered = deferred<void>(); wait = deferred<GitComparison | GitComparisonFile>();
    const pending = app.request(fileRoute); await entered.promise;
    app.policies.updateSpace(space.id, { expectedVersion: space.version, view: members(app.alice!.id) }, app.alice!.id);
    wait.resolve(file); assert.equal((await pending).body.code, 'OBJECT_UNAVAILABLE');
  } finally { await app.close(); }
});

test('comparison responses carry the current epoch and sanitize unexpected observer failures', async () => {
  let entered = deferred<void>(), wait = deferred<GitComparison>();
  const app = await start({ password: true, observer: observer({ compare: async () => { entered.resolve(); return wait.promise; } }) });
  try {
    const oldEpoch = app.policies.epoch(); const pending = app.request<GitComparison>(route); await entered.promise;
    app.policy({ edit: members(app.alice!.id) }); assert.ok(app.policies.epoch() > oldEpoch); wait.resolve(inventory);
    const result = await pending; assert.equal(result.status, 200); assert.equal(result.body.accessEpoch, app.policies.epoch()); assert.equal(result.headers.get('cache-control'), 'no-store');
    entered = deferred<void>(); wait = deferred<GitComparison>(); const failing = app.request(route); await entered.promise; wait.reject(new Error('/private/operator/repository PRIVATE'));
    const failure = await failing; assert.equal(failure.status, 503); assert.deepEqual(failure.body, { error: 'Repository contents are unavailable.', code: 'GIT_UNAVAILABLE' });
  } finally { await app.close(); }
});

test('pending comparison content rechecks credential revocation, read scope and disabled accounts', async () => {
  let entered = deferred<void>(), wait = deferred<GitComparisonFile>();
  const app = await start({ password: true, observer: observer({ compareFile: async () => { entered.resolve(); return wait.promise; } }) });
  try {
    for (const mutation of ['revoke', 'scope', 'disable'] as const) {
      entered = deferred<void>(); wait = deferred<GitComparisonFile>(); const token = app.auth.createToken(app.bob!.id, { name: mutation, scopes: ['read'] });
      const pending = app.request(fileRoute, token.token); await entered.promise;
      if (mutation === 'revoke') app.auth.revokeToken(app.bob!.id, token.record.id);
      else if (mutation === 'scope') app.store.database.prepare('UPDATE auth_tokens SET scopes = ? WHERE id = ?').run('["write"]', token.record.id);
      else app.auth.setAccountDisabled(app.bob!.id, true);
      wait.resolve(file); const denied = await pending; assert.equal(denied.status, mutation === 'scope' ? 403 : 401); assert.ok(!JSON.stringify(denied.body).includes('PRIVATE'));
    }
  } finally { await app.close(); }
});

test('browser comparison reads require current session context and recheck session expiry', async () => {
  const entered = deferred<void>(), wait = deferred<GitComparisonFile>(); let calls = 0;
  const app = await start({ password: true, observer: observer({ compareFile: async () => { calls++; entered.resolve(); return wait.promise; } }) });
  try {
    const bootstrap = await fetch(app.url('/api/session')); const challenge = await bootstrap.json() as SessionState;
    const login = await fetch(app.url('/api/login'), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: app.origin, Cookie: bootstrap.headers.getSetCookie().map(value => value.split(';')[0]!).join('; '), 'X-CSRF-Token': challenge.csrfToken! }, body: JSON.stringify({ username: 'bob', password: 'Bob exact comparison password' }) });
    assert.equal(login.status, 200); const session = await login.json() as SessionState; const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]!).join('; ');
    for (const context of [undefined, 'former-session']) assert.equal((await fetch(app.url(fileRoute), { headers: { Cookie: cookie, ...(context ? { 'X-Session-Context': context } : {}) } })).status, 401);
    assert.equal(calls, 0);
    const pending = fetch(app.url(fileRoute), { headers: { Cookie: cookie, 'X-Session-Context': session.sessionContext! } }); await entered.promise;
    app.store.database.prepare('UPDATE auth_sessions SET expires_at = 0').run(); wait.resolve(file);
    const denied = await pending; assert.equal(denied.status, 401); assert.ok(!JSON.stringify(await denied.json()).includes('PRIVATE'));
  } finally { await app.close(); }
});

test('comparison disconnect and shutdown cancel observers that never settle', async () => {
  let entered = deferred<AbortSignal>();
  const pending = async (_id: string, _query: GitComparisonQuery, signal?: AbortSignal): Promise<never> => { assert.ok(signal); entered.resolve(signal); return new Promise<never>(() => undefined); };
  const app = await start({ observer: observer({ compare: pending, compareFile: pending }) });
  try {
    const request = httpRequest(app.url(route)); request.on('error', () => undefined); request.end();
    const first = await entered.promise; const aborted = new Promise<void>(resolve => first.addEventListener('abort', () => resolve(), { once: true })); request.destroy(); await aborted;
    assert.equal(first.aborted, true); entered = deferred<AbortSignal>();
    const response = app.request(fileRoute); const second = await entered.promise; await app.close();
    assert.equal(second.aborted, true); assert.equal((await response).body.code, 'GIT_ABORTED');
  } finally { await app.close(); }
});

test('comparison child failures retain visible repository access and explicit resource-limit errors', async () => {
  const app = await start({ observer: observer({ compare: async () => { throw new HttpError(422, 'Comparison exceeds the configured bounds.', 'GIT_LIMIT_EXCEEDED'); }, compareFile: async () => { throw new HttpError(404, 'Git object is unavailable.', 'GIT_OBJECT_UNAVAILABLE'); } }) });
  try {
    const large = await app.request(route); assert.equal(large.status, 422); assert.equal(large.body.code, 'GIT_LIMIT_EXCEEDED');
    const missing = await app.request(fileRoute); assert.equal(missing.status, 404); assert.equal(missing.body.code, 'GIT_OBJECT_UNAVAILABLE');
    assert.equal((await app.request('/api/repositories/R1')).status, 200);
  } finally { await app.close(); }
});
