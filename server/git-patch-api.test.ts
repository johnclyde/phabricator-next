import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from './app.ts';
import { createAuth } from './auth.ts';
import { createStore } from './store.ts';
import type { GitObserver } from './git.ts';
import { HttpError } from './validation.ts';
import type { GitPatch, GitCommit, GitComparisonQuery } from '../shared/repositories.ts';
import type { SessionState } from '../shared/auth.ts';
import { createGitFixture, createGitComparisonFixture, type GitFixture } from '../tests/git-fixture.ts';

const base = 'a'.repeat(40), target = 'b'.repeat(40);
const person = { name: 'PRIVATE author', email: 'private@example.test', timestamp: '2026-01-01T00:00:00.000Z' };
const commit = (id: string): GitCommit => ({ id, treeId: (id === base ? 'c' : 'd').repeat(40), parentIds: [], author: person, committer: person, message: 'PRIVATE commit message', messageTruncated: false });
const bytes = Buffer.from('PRIVATE patch bytes\x00\xff', 'latin1');
const result: GitPatch = { repositoryId: 'R1', objectFormat: 'sha1', format: 'git-binary-patch-v1', baseCommit: commit(base), targetCommit: commit(target), baseTreeId: commit(base).treeId, targetTreeId: commit(target).treeId, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), dataBase64: bytes.toString('base64') };
const route = `/api/repositories/R1/compare/patch?base=${base}&target=${target}`;
const members = (...principalIds: string[]) => ({ kind: 'principals' as const, principalIds });
const workspace = { kind: 'workspace' as const };
type ErrorBody = { error: string; code?: string };
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function observer(patch: GitObserver['patch'] = async () => result): GitObserver {
  const unavailable = async (): Promise<never> => { throw new HttpError(503, 'Fixture read is unavailable.', 'GIT_UNAVAILABLE'); };
  return { info: async () => ({ state: 'ready', objectFormat: 'sha1' }), refs: unavailable, commit: unavailable, tree: unavailable, blob: unavailable, history: unavailable, importSnapshot: unavailable, compare: unavailable, compareFile: unavailable, blame: unavailable, patch };
}
async function start(options: { patch?: GitObserver['patch']; password?: boolean; basePath?: string; barePath?: string } = {}) {
  const store = createStore({ path: ':memory:' }), basePath = options.basePath ?? '/';
  const provision = createAuth({ database: store.database, mode: 'local', basePath, provisioning: true });
  const alice = options.password ? await provision.createAccount({ username: 'alice', displayName: 'Alice', password: 'Alice exact patch password' }) : undefined;
  const bob = options.password ? await provision.createAccount({ username: 'bob', displayName: 'Bob', password: 'Bob exact patch password' }) : undefined;
  const app = createApp({ store, seed: false, basePath, authMode: options.password ? 'password' : 'local', ...(options.barePath ? { gitRepositories: { R1: options.barePath } } : { gitObserver: observer(options.patch) }) });
  const token = bob ? app.auth.createToken(bob.id, { name: 'Read patch', scopes: ['read'] }) : undefined;
  store.createRepository({ name: 'Patch source', remoteUrl: 'https://example.invalid/not-fetched.git' });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`, url = (path: string) => origin + basePath.slice(0, -1) + path;
  async function request<T = ErrorBody>(path: string, bearer = token?.token) { const response = await fetch(url(path), { signal: AbortSignal.timeout(15_000), headers: bearer ? { Authorization: `Bearer ${bearer}` } : {} }); return { status: response.status, body: await response.json() as T, headers: response.headers }; }
  function policy(fields: Record<string, unknown>) { const old = app.policies.policy('R1', alice!.id); return app.policies.setPolicy('R1', { expectedVersion: old.version, spaceId: old.spaceId, ...old.rules, ...fields }, alice!.id); }
  let closed = false;
  return { ...app, alice, bob, token, origin, url, request, policy, close: async () => { if (closed) return; closed = true; await app.close(); store.close(); } };
}

/** Apply only to a disposable index: no checkout, executable files or submodule fetch. */
function indexGit(fixture: GitFixture, args: string[], input?: Uint8Array): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['--git-dir', fixture.barePath, ...args], { cwd: fixture.root, env: { PATH: '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin', HOME: fixture.root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null', GIT_INDEX_FILE: join(fixture.root, 'patch-test-index'), GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', LC_ALL: 'C' }, stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [], err: Buffer[] = []; const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.stdout.on('data', (data: Buffer) => out.push(data)); child.stderr.on('data', (data: Buffer) => err.push(data)); child.once('error', reject);
    child.once('close', code => { clearTimeout(timer); if (code === 0) resolve(Buffer.concat(out).toString('utf8').trim()); else reject(new Error(`Disposable patch application failed: ${Buffer.concat(err).toString('utf8')}`)); });
    child.stdin.on('error', () => undefined); child.stdin.end(input);
  });
}
function patchBytes(value: GitPatch): Buffer {
  const data = Buffer.from(value.dataBase64, 'base64'); assert.equal(data.toString('base64'), value.dataBase64); assert.equal(data.length, value.bytes); assert.equal(createHash('sha256').update(data).digest('hex'), value.sha256); return data;
}
for (const [format, basePath] of [['sha1', '/'], ['sha256', '/phabricator/']] as const) test(`read-only HTTP patch roundtrips exact ${format} trees at ${basePath}`, async () => {
  const fixture = await createGitFixture(format), pair = await createGitComparisonFixture(fixture), app = await start({ barePath: fixture.barePath, basePath, password: true });
  try {
    const route = `/api/repositories/R1/compare/patch?base=${pair.base}&target=${pair.target}`, response = await app.request<GitPatch>(route);
    assert.equal(response.status, 200, JSON.stringify(response.body)); assert.equal(response.body.repositoryId, 'R1'); assert.equal(response.body.objectFormat, format); assert.equal(response.body.format, 'git-binary-patch-v1');
    assert.equal(response.body.baseCommit!.id, pair.base); assert.equal(response.body.targetCommit.id, pair.target);
    assert.equal(response.body.baseTreeId, (await fixture.git(['rev-parse', `${pair.base}^{tree}`])).trim()); assert.equal(response.body.targetTreeId, (await fixture.git(['rev-parse', `${pair.target}^{tree}`])).trim());
    assert.equal(response.body.accessEpoch, app.policies.epoch()); assert.equal(response.headers.get('cache-control'), 'no-store'); assert.ok(!JSON.stringify(response.body).includes(fixture.barePath));
    const data = patchBytes(response.body); assert.ok(data.includes(Buffer.from('GIT binary patch'))); assert.ok(data.includes(Buffer.from('rename from rename-before.txt'))); assert.ok(data.includes(Buffer.from('new mode 100755')));
    await indexGit(fixture, ['read-tree', response.body.baseTreeId]); await indexGit(fixture, ['apply', '--cached', '--binary', '--whitespace=nowarn', '-'], data); assert.equal(await indexGit(fixture, ['write-tree']), response.body.targetTreeId);
    // Native copy metadata is not necessarily reversible with --reverse. An
    // independently generated swapped pair must reproduce the original tree.
    const reverse = await app.request<GitPatch>(`/api/repositories/R1/compare/patch?base=${pair.target}&target=${pair.base}`);
    assert.equal(reverse.status, 200, JSON.stringify(reverse.body)); assert.equal(reverse.body.baseTreeId, response.body.targetTreeId); assert.equal(reverse.body.targetTreeId, response.body.baseTreeId);
    await indexGit(fixture, ['apply', '--cached', '--binary', '--whitespace=nowarn', '-'], patchBytes(reverse.body)); assert.equal(await indexGit(fixture, ['write-tree']), response.body.baseTreeId);
    await fixture.advanceMain(); assert.deepEqual((await app.request<GitPatch>(route)).body, response.body);
    const root = await app.request<GitPatch>(`/api/repositories/R1/compare/patch?base=empty&target=${fixture.base}`); assert.equal(root.status, 200); assert.equal(root.body.baseCommit, null); await indexGit(fixture, ['read-tree', '--empty']); await indexGit(fixture, ['apply', '--cached', '--binary', '-'], patchBytes(root.body)); assert.equal(await indexGit(fixture, ['write-tree']), root.body.targetTreeId);
    const unchanged = await app.request<GitPatch>(`/api/repositories/R1/compare/patch?base=${fixture.importCommit}&target=${fixture.importEqualCommit}`); assert.equal(unchanged.status, 200); assert.deepEqual(patchBytes(unchanged.body), Buffer.alloc(0)); assert.equal(unchanged.body.baseTreeId, unchanged.body.targetTreeId);
    for (const pair of [{ base: fixture.base, target: '0'.repeat(format === 'sha1' ? 40 : 64) }, { base: fixture.base, target: fixture.readmeBlob }]) { const missing = await app.request(`/api/repositories/R1/compare/patch?${new URLSearchParams(pair)}`); assert.equal(missing.status, 404); assert.equal(missing.body.code, 'GIT_OBJECT_UNAVAILABLE'); assert.ok(!JSON.stringify(missing.body).includes(fixture.barePath)); }
    if (basePath !== '/') assert.equal((await fetch(app.origin + route)).status, 404);
  } finally { await app.close(); await fixture.close(); }
});

test('patch query rejects mutable, ambiguous and unsupported selectors before Git', async () => {
  const calls: GitComparisonQuery[] = [], app = await start({ patch: async (_id, query) => { calls.push(query); return result; } });
  try {
    const invalid = ['', `?base=${base}`, `?target=${target}`, `?base=&target=${target}`, `?base=main&target=${target}`, `?base=${base}&target=HEAD`, `?base=${base.toUpperCase()}&target=${target}`, `?base=${'a'.repeat(64)}&target=${target}`, `?base=${base}&target=${target}&target=${target}`, `?base=${base}&base=empty&target=${target}`, ...['path=a', 'beforePath=a', 'afterPath=b', 'context=0', 'timeout=1', 'format=patch'].map(option => `?base=${base}&target=${target}&${option}`)];
    for (const suffix of invalid) { const failed = await app.request(`/api/repositories/R1/compare/patch${suffix}`); assert.equal(failed.status, 400, suffix); assert.equal(failed.body.code, 'GIT_INVALID_QUERY'); } assert.equal(calls.length, 0);
    assert.equal((await app.request(route)).status, 200); assert.equal((await app.request(route.replace(base, 'empty'))).status, 200); assert.deepEqual(calls, [{ base, target }, { base: null, target }]);
  } finally { await app.close(); }
});

test('hidden repositories, restricted Spaces and missing read scopes reveal no patch metadata', async () => {
  let calls = 0; const app = await start({ password: true, patch: async () => { calls++; return result; } });
  try {
    const token = app.auth.createToken(app.bob!.id, { name: 'Write only', scopes: ['write'] }); assert.equal((await app.request(route, token.token)).status, 403);
    app.policy({ view: members(app.alice!.id), edit: members(app.alice!.id) }); const missing = await app.request(route.replace('R1', 'R999'));
    for (const hidden of [route, '/api/repositories/R1/compare/patch?secret=invalid']) { const denied = await app.request(hidden); assert.equal(denied.status, 404); assert.deepEqual(denied.body, missing.body); }
    const space = app.policies.createSpace({ name: 'Restricted source', view: members(app.alice!.id), edit: members(app.alice!.id) }, app.alice!.id); app.policy({ spaceId: space.id, view: workspace });
    assert.deepEqual((await app.request(route)).body, missing.body); assert.equal(calls, 0);
  } finally { await app.close(); }
});

test('pending patch success and failure recheck repository and Space access outside the database snapshot', async () => {
  let wait = deferred<GitPatch>(), entered = deferred<void>(); const app = await start({ password: true, patch: async () => { entered.resolve(); return wait.promise; } });
  try {
    for (const authority of ['repository', 'space'] as const) for (const failure of [false, true]) {
      const space = app.policies.createSpace({ name: 'Initially visible source', view: workspace, edit: members(app.alice!.id) }, app.alice!.id); app.policy({ spaceId: space.id, view: workspace, edit: members(app.alice!.id) }); wait = deferred<GitPatch>(); entered = deferred<void>();
      const pending = app.request(route); await entered.promise; assert.doesNotThrow(() => app.store.database.exec('BEGIN IMMEDIATE; ROLLBACK;'));
      if (authority === 'repository') app.policy({ view: members(app.alice!.id) }); else app.policies.updateSpace(space.id, { expectedVersion: space.version, view: members(app.alice!.id) }, app.alice!.id);
      if (failure) wait.reject(new HttpError(422, 'PRIVATE patch data /operator/source', 'GIT_INVALID_OBJECT')); else wait.resolve(result);
      const denied = await pending; assert.equal(denied.status, 404); assert.equal(denied.body.code, 'OBJECT_UNAVAILABLE'); assert.ok(!JSON.stringify(denied.body).includes('PRIVATE') && !Object.hasOwn(denied.body, 'dataBase64'));
    }
  } finally { await app.close(); }
});

test('patch returns the current access epoch and safe failures without retiring visible repository access', async () => {
  let wait = deferred<GitPatch>(), entered = deferred<void>(); const app = await start({ password: true, patch: async () => { entered.resolve(); return wait.promise; } });
  try {
    const before = app.policies.epoch(), pending = app.request<GitPatch>(route); await entered.promise; app.policy({ edit: members(app.alice!.id) }); wait.resolve(result);
    const response = await pending; assert.equal(response.status, 200); assert.ok(response.body.accessEpoch! > before); assert.equal(response.body.accessEpoch, app.policies.epoch()); assert.equal(response.headers.get('cache-control'), 'no-store');
    for (const failure of [new Error('/operator/private/source PRIVATE'), new HttpError(422, 'Patch exceeds the supported limit.', 'GIT_LIMIT_EXCEEDED')]) {
      wait = deferred<GitPatch>(); entered = deferred<void>(); const pending = app.request(route); await entered.promise; wait.reject(failure); const response = await pending;
      assert.equal(response.status, failure instanceof HttpError ? 422 : 503); assert.equal(response.body.code, failure instanceof HttpError ? 'GIT_LIMIT_EXCEEDED' : 'GIT_UNAVAILABLE'); assert.ok(!JSON.stringify(response.body).includes('PRIVATE')); assert.equal((await app.request('/api/repositories/R1')).status, 200);
    }
  } finally { await app.close(); }
});

test('patch rechecks revoked credentials, read scopes and disabled accounts before returning source or patch data', async () => {
  let wait = deferred<GitPatch>(), entered = deferred<void>(); const app = await start({ password: true, patch: async () => { entered.resolve(); return wait.promise; } });
  try {
    for (const change of ['revoke', 'scope', 'disable'] as const) {
      wait = deferred<GitPatch>(); entered = deferred<void>(); const token = app.auth.createToken(app.bob!.id, { name: change, scopes: ['read'] }); const pending = app.request(route, token.token); await entered.promise;
      if (change === 'revoke') app.auth.revokeToken(app.bob!.id, token.record.id); else if (change === 'scope') app.store.database.prepare('UPDATE auth_tokens SET scopes = ? WHERE id = ?').run('["write"]', token.record.id); else app.auth.setAccountDisabled(app.bob!.id, true);
      wait.resolve(result); const denied = await pending; assert.equal(denied.status, change === 'scope' ? 403 : 401); assert.ok(!JSON.stringify(denied.body).includes('PRIVATE') && !Object.hasOwn(denied.body, 'dataBase64'));
    }
  } finally { await app.close(); }
});

test('browser patch requires current session context and rechecks session expiration after Git', async () => {
  const wait = deferred<GitPatch>(), entered = deferred<void>(); let calls = 0; const app = await start({ password: true, patch: async () => { calls++; entered.resolve(); return wait.promise; } });
  try {
    const bootstrap = await fetch(app.url('/api/session')), challenge = await bootstrap.json() as SessionState;
    const login = await fetch(app.url('/api/login'), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: app.origin, Cookie: bootstrap.headers.getSetCookie().map(value => value.split(';')[0]!).join('; '), 'X-CSRF-Token': challenge.csrfToken! }, body: JSON.stringify({ username: 'bob', password: 'Bob exact patch password' }) }); assert.equal(login.status, 200);
    const session = await login.json() as SessionState, cookie = login.headers.getSetCookie().map(value => value.split(';')[0]!).join('; ');
    for (const context of [undefined, 'retired-session']) assert.equal((await fetch(app.url(route), { headers: { Cookie: cookie, ...(context ? { 'X-Session-Context': context } : {}) } })).status, 401); assert.equal(calls, 0);
    const pending = fetch(app.url(route), { headers: { Cookie: cookie, 'X-Session-Context': session.sessionContext! } }); await entered.promise; app.store.database.prepare('UPDATE auth_sessions SET expires_at = 0').run(); wait.resolve(result);
    const expired = await pending; assert.equal(expired.status, 401); assert.ok(!JSON.stringify(await expired.json()).includes('PRIVATE'));
  } finally { await app.close(); }
});

test('patch disconnect and application shutdown abort observers even when they never settle', async () => {
  let entered = deferred<AbortSignal>(); const app = await start({ patch: async (_id, _query, signal) => { assert.ok(signal); entered.resolve(signal); return new Promise<never>(() => undefined); } });
  try {
    const request = httpRequest(app.url(route)); request.on('error', () => undefined); request.end(); const first = await entered.promise;
    const aborted = new Promise<void>(resolve => first.addEventListener('abort', () => resolve(), { once: true })); request.destroy(); await aborted; assert.equal(first.aborted, true);
    entered = deferred<AbortSignal>(); const pending = app.request(route); const second = await entered.promise; await app.close(); assert.equal(second.aborted, true); assert.equal((await pending).body.code, 'GIT_ABORTED');
  } finally { await app.close(); }
});
