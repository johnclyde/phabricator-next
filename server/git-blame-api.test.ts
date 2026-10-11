import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from './app.ts';
import { createAuth } from './auth.ts';
import { createStore } from './store.ts';
import type { GitObserver } from './git.ts';
import { HttpError } from './validation.ts';
import type { GitBlame, GitCommit } from '../shared/repositories.ts';
import type { SessionState } from '../shared/auth.ts';
import { createGitFixture } from '../tests/git-fixture.ts';
import { createGitBlameFixture } from '../tests/git-blame-fixture.ts';
import { validGitBlame } from '../shared/git-blame.ts';

const commitId = 'a'.repeat(40), path = 'unicodé/研究 #%\\.md';
const person = { name: 'PRIVATE author', email: 'private@example.test', timestamp: '2026-01-01T00:00:00.000Z' };
const commit: GitCommit = { id: commitId, treeId: 'b'.repeat(40), parentIds: [], author: person, committer: person, message: 'PRIVATE commit message', messageTruncated: false };
const result: GitBlame = { repositoryId: 'R1', objectFormat: 'sha1', algorithm: 'git-blame-root', commit, blob: { repositoryId: 'R1', objectFormat: 'sha1', commitId, path, objectId: 'c'.repeat(40), mode: '100644', state: 'text', content: 'PRIVATE\n', size: 8 }, lines: [{ lineNumber: 1, commitId, originalLine: 1, path }], commits: [commit] };
const route = `/api/repositories/R1/blame?${new URLSearchParams({ commit: commitId, path })}`;
const members = (...principalIds: string[]) => ({ kind: 'principals' as const, principalIds });
const workspace = { kind: 'workspace' as const };
type ErrorBody = { error: string; code?: string };
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function observer(blame: GitObserver['blame'] = async () => result): GitObserver {
  const unavailable = async (): Promise<never> => { throw new HttpError(503, 'Fixture read is unavailable.', 'GIT_UNAVAILABLE'); };
  return { info: async () => ({ state: 'ready', objectFormat: 'sha1' }), refs: unavailable, commit: unavailable, tree: unavailable, blob: unavailable, history: unavailable, importSnapshot: unavailable, compare: unavailable, compareFile: unavailable, blame };
}
async function start(options: { blame?: GitObserver['blame']; password?: boolean; basePath?: string; barePath?: string } = {}) {
  const store = createStore({ path: ':memory:' }), basePath = options.basePath ?? '/';
  const provision = createAuth({ database: store.database, mode: 'local', basePath, provisioning: true });
  const alice = options.password ? await provision.createAccount({ username: 'alice', displayName: 'Alice', password: 'Alice exact blame password' }) : undefined;
  const bob = options.password ? await provision.createAccount({ username: 'bob', displayName: 'Bob', password: 'Bob exact blame password' }) : undefined;
  const app = createApp({ store, seed: false, basePath, authMode: options.password ? 'password' : 'local', ...(options.barePath ? { gitRepositories: { R1: options.barePath } } : { gitObserver: observer(options.blame) }) });
  const token = bob ? app.auth.createToken(bob.id, { name: 'Read blame', scopes: ['read'] }) : undefined;
  store.createRepository({ name: 'Blame source', remoteUrl: 'https://example.invalid/not-fetched.git' });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`, url = (path: string) => origin + basePath.slice(0, -1) + path;
  async function request<T = ErrorBody>(path: string, bearer = token?.token) { const response = await fetch(url(path), { signal: AbortSignal.timeout(15_000), headers: bearer ? { Authorization: `Bearer ${bearer}` } : {} }); return { status: response.status, body: await response.json() as T, headers: response.headers }; }
  function policy(fields: Record<string, unknown>) { const old = app.policies.policy('R1', alice!.id); return app.policies.setPolicy('R1', { expectedVersion: old.version, spaceId: old.spaceId, ...old.rules, ...fields }, alice!.id); }
  let closed = false;
  return { ...app, alice, bob, token, origin, url, request, policy, close: async () => { if (closed) return; closed = true; await app.close(); store.close(); } };
}

for (const [format, basePath] of [['sha1', '/'], ['sha256', '/phabricator/']] as const) test(`read-only HTTP blame binds exact ${format} source and attribution at ${basePath}`, async () => {
  const fixture = await createGitFixture(format), app = await start({ barePath: fixture.barePath, basePath, password: true });
  try {
    const route = `/api/repositories/R1/blame?commit=${fixture.head}&path=README.md`, response = await app.request<GitBlame>(route);
    assert.equal(response.status, 200, JSON.stringify(response.body)); assert.equal(response.body.repositoryId, 'R1'); assert.equal(response.body.objectFormat, format); assert.equal(response.body.algorithm, 'git-blame-root');
    assert.equal(response.body.commit.id, fixture.head); assert.equal(response.body.blob.commitId, fixture.head); assert.equal(response.body.blob.path, 'README.md'); assert.equal(response.body.blob.state, 'text');
    if (response.body.blob.state === 'text') assert.equal(response.body.blob.content, '# Example repository\nAfter the change.\n');
    assert.deepEqual(response.body.lines?.map(line => [line.lineNumber, line.commitId, line.originalLine, line.path]), [[1, fixture.base, 1, 'README.md'], [2, response.body.commit.parentIds[0], 2, 'README.md']]);
    assert.deepEqual(new Set(response.body.commits.map(commit => commit.id)), new Set(response.body.lines!.map(line => line.commitId)));
    assert.equal(response.body.accessEpoch, app.policies.epoch()); assert.equal(response.headers.get('cache-control'), 'no-store'); assert.ok(!JSON.stringify(response.body).includes(fixture.barePath));
    await fixture.advanceMain('New head must not move this annotation.\n'); assert.deepEqual((await app.request<GitBlame>(route)).body, response.body);
    const root = await app.request<GitBlame>(`/api/repositories/R1/blame?commit=${fixture.base}&path=README.md`); assert.equal(root.status, 200); assert.ok(root.body.lines!.every(line => line.commitId === fixture.base)); assert.equal(root.body.lines!.length, 2);
    const empty = await app.request<GitBlame>(`/api/repositories/R1/blame?commit=${fixture.head}&path=docs/empty.txt`); assert.equal(empty.status, 200); assert.deepEqual(empty.body.lines, []); assert.deepEqual(empty.body.commits, []); assert.equal(empty.body.blob.state, 'text');
    for (const [path, state] of [['binary.dat', 'binary'], ['invalid.txt', 'unsupported_encoding'], ['oversized.txt', 'oversized'], ['link', 'symlink'], ['module', 'submodule']] as const) {
      const nontext = await app.request<GitBlame>(`/api/repositories/R1/blame?commit=${fixture.head}&path=${path}`); assert.equal(nontext.status, 200, JSON.stringify(nontext.body)); assert.equal(nontext.body.blob.state, state); assert.equal(nontext.body.lines, null); assert.deepEqual(nontext.body.commits, []); assert.equal(Object.hasOwn(nontext.body.blob, 'content'), false);
    }
    for (const query of [{ commit: fixture.head, path: 'missing' }, { commit: '0'.repeat(format === 'sha1' ? 40 : 64), path: 'README.md' }, { commit: fixture.readmeBlob, path: 'README.md' }]) {
      const missing = await app.request(`/api/repositories/R1/blame?${new URLSearchParams(query)}`); assert.equal(missing.status, 404); assert.equal(missing.body.code, 'GIT_OBJECT_UNAVAILABLE'); assert.ok(!JSON.stringify(missing.body).includes(fixture.barePath));
    }
    assert.equal((await app.request('/api/repositories/R1')).status, 200); if (basePath !== '/') assert.equal((await fetch(app.origin + route)).status, 404);
  } finally { await app.close(); await fixture.close(); }
});

test('HTTP blame retains renamed original paths, both merge parents and exact CRLF/BOM source', async () => {
  const fixture = await createGitFixture(), history = await createGitBlameFixture(fixture), app = await start({ barePath: fixture.barePath });
  try {
    const route = `/api/repositories/R1/blame?${new URLSearchParams({ commit: history.merge, path: history.path })}`, response = await app.request<GitBlame>(route);
    assert.equal(response.status, 200, JSON.stringify(response.body)); assert.equal(validGitBlame(response.body, 'R1', history.merge, history.path), true);
    assert.equal(response.body.blob.state, 'text'); if (response.body.blob.state === 'text') assert.equal(response.body.blob.content, history.content);
    assert.deepEqual(response.body.lines?.map(line => line.commitId), [history.root, history.root, history.main, history.feature, history.edit, history.edit, history.merge]);
    assert.deepEqual(response.body.lines?.map(line => line.path), [history.originalPath, history.originalPath, history.path, history.path, history.originalPath, history.originalPath, history.path]);
    assert.deepEqual(response.body.lines?.map(line => line.originalLine), [1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(response.body.commit.parentIds, [history.main, history.feature]);
    const origin = response.body.lines![0]!, original = await app.request<GitBlame>(`/api/repositories/R1/blame?${new URLSearchParams({ commit: origin.commitId, path: origin.path })}`);
    assert.equal(original.status, 200); assert.equal(original.body.blob.path, history.originalPath); assert.equal(original.body.blob.state, 'text'); if (original.body.blob.state === 'text') assert.equal(original.body.blob.content, history.rootContent);
    assert.ok(!JSON.stringify(response.body).includes(fixture.barePath));
  } finally { await app.close(); await fixture.close(); }
});

test('blame rejects ambiguous selectors before Git and passes valid literal paths without normalizing them', async () => {
  const calls: Array<[string, string, string]> = [], app = await start({ blame: async (id, commit, path) => { calls.push([id, commit, path]); return result; } });
  try {
    const invalid = ['', `?commit=${commitId}`, '?path=README.md', `?commit=${commitId}&path=`, '?commit=main&path=a', '?commit=HEAD&path=a', `?commit=${commitId.toUpperCase()}&path=a`, `?commit=${commitId}&commit=${commitId}&path=a`, `?commit=${commitId}&path=a&path=b`, `?commit=${commitId}&path=a&line=1`, `?commit=${commitId}&path=a&timeout=1`, ...['/etc/passwd', '../secret', 'a/../b', 'a//b', 'a\u0000b'].map(path => `?commit=${commitId}&path=${encodeURIComponent(path)}`)];
    for (const suffix of invalid) { const failed = await app.request(`/api/repositories/R1/blame${suffix}`); assert.equal(failed.status, 400, suffix); assert.equal(failed.body.code, 'GIT_INVALID_QUERY'); }
    assert.equal(calls.length, 0); assert.equal((await app.request(route)).status, 200); assert.deepEqual(calls, [['R1', commitId, path]]);
  } finally { await app.close(); }
});

test('hidden repositories, restricted Spaces and missing read scopes reveal no blame metadata', async () => {
  let calls = 0; const app = await start({ password: true, blame: async () => { calls++; return result; } });
  try {
    const token = app.auth.createToken(app.bob!.id, { name: 'Write only', scopes: ['write'] }); assert.equal((await app.request(route, token.token)).status, 403);
    app.policy({ view: members(app.alice!.id), edit: members(app.alice!.id) }); const missing = await app.request(route.replace('R1', 'R999'));
    for (const hidden of [route, '/api/repositories/R1/blame?secret=invalid']) { const denied = await app.request(hidden); assert.equal(denied.status, 404); assert.deepEqual(denied.body, missing.body); }
    const space = app.policies.createSpace({ name: 'Restricted source', view: members(app.alice!.id), edit: members(app.alice!.id) }, app.alice!.id); app.policy({ spaceId: space.id, view: workspace });
    assert.deepEqual((await app.request(route)).body, missing.body); assert.equal(calls, 0);
  } finally { await app.close(); }
});

test('pending blame success and failure recheck repository and Space access outside the database snapshot', async () => {
  let wait = deferred<GitBlame>(), entered = deferred<void>(); const app = await start({ password: true, blame: async () => { entered.resolve(); return wait.promise; } });
  try {
    for (const authority of ['repository', 'space'] as const) for (const failure of [false, true]) {
      const space = app.policies.createSpace({ name: 'Initially visible source', view: workspace, edit: members(app.alice!.id) }, app.alice!.id); app.policy({ spaceId: space.id, view: workspace, edit: members(app.alice!.id) }); wait = deferred<GitBlame>(); entered = deferred<void>();
      const pending = app.request(route); await entered.promise; assert.doesNotThrow(() => app.store.database.exec('BEGIN IMMEDIATE; ROLLBACK;'));
      if (authority === 'repository') app.policy({ view: members(app.alice!.id) }); else app.policies.updateSpace(space.id, { expectedVersion: space.version, view: members(app.alice!.id) }, app.alice!.id);
      if (failure) wait.reject(new HttpError(422, 'PRIVATE attribution /operator/source', 'GIT_INVALID_OBJECT')); else wait.resolve(result);
      const denied = await pending; assert.equal(denied.status, 404); assert.equal(denied.body.code, 'OBJECT_UNAVAILABLE'); assert.ok(!JSON.stringify(denied.body).includes('PRIVATE'));
    }
  } finally { await app.close(); }
});

test('blame returns the current access epoch and safe failures without retiring visible repository access', async () => {
  let wait = deferred<GitBlame>(), entered = deferred<void>(); const app = await start({ password: true, blame: async () => { entered.resolve(); return wait.promise; } });
  try {
    const before = app.policies.epoch(), pending = app.request<GitBlame>(route); await entered.promise; app.policy({ edit: members(app.alice!.id) }); wait.resolve(result);
    const response = await pending; assert.equal(response.status, 200); assert.ok(response.body.accessEpoch! > before); assert.equal(response.body.accessEpoch, app.policies.epoch()); assert.equal(response.headers.get('cache-control'), 'no-store');
    for (const failure of [new Error('/operator/private/source PRIVATE'), new HttpError(422, 'Blame exceeds the supported limit.', 'GIT_LIMIT_EXCEEDED')]) {
      wait = deferred<GitBlame>(); entered = deferred<void>(); const pending = app.request(route); await entered.promise; wait.reject(failure); const response = await pending;
      assert.equal(response.status, failure instanceof HttpError ? 422 : 503); assert.equal(response.body.code, failure instanceof HttpError ? 'GIT_LIMIT_EXCEEDED' : 'GIT_UNAVAILABLE'); assert.ok(!JSON.stringify(response.body).includes('PRIVATE')); assert.equal((await app.request('/api/repositories/R1')).status, 200);
    }
  } finally { await app.close(); }
});

test('blame rechecks revoked credentials, read scopes and disabled accounts before returning source or attribution', async () => {
  let wait = deferred<GitBlame>(), entered = deferred<void>(); const app = await start({ password: true, blame: async () => { entered.resolve(); return wait.promise; } });
  try {
    for (const change of ['revoke', 'scope', 'disable'] as const) {
      wait = deferred<GitBlame>(); entered = deferred<void>(); const token = app.auth.createToken(app.bob!.id, { name: change, scopes: ['read'] }); const pending = app.request(route, token.token); await entered.promise;
      if (change === 'revoke') app.auth.revokeToken(app.bob!.id, token.record.id); else if (change === 'scope') app.store.database.prepare('UPDATE auth_tokens SET scopes = ? WHERE id = ?').run('["write"]', token.record.id); else app.auth.setAccountDisabled(app.bob!.id, true);
      wait.resolve(result); const denied = await pending; assert.equal(denied.status, change === 'scope' ? 403 : 401); assert.ok(!JSON.stringify(denied.body).includes('PRIVATE'));
    }
  } finally { await app.close(); }
});

test('browser blame requires current session context and rechecks session expiration after Git', async () => {
  const wait = deferred<GitBlame>(), entered = deferred<void>(); let calls = 0; const app = await start({ password: true, blame: async () => { calls++; entered.resolve(); return wait.promise; } });
  try {
    const bootstrap = await fetch(app.url('/api/session')), challenge = await bootstrap.json() as SessionState;
    const login = await fetch(app.url('/api/login'), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: app.origin, Cookie: bootstrap.headers.getSetCookie().map(value => value.split(';')[0]!).join('; '), 'X-CSRF-Token': challenge.csrfToken! }, body: JSON.stringify({ username: 'bob', password: 'Bob exact blame password' }) }); assert.equal(login.status, 200);
    const session = await login.json() as SessionState, cookie = login.headers.getSetCookie().map(value => value.split(';')[0]!).join('; ');
    for (const context of [undefined, 'retired-session']) assert.equal((await fetch(app.url(route), { headers: { Cookie: cookie, ...(context ? { 'X-Session-Context': context } : {}) } })).status, 401); assert.equal(calls, 0);
    const pending = fetch(app.url(route), { headers: { Cookie: cookie, 'X-Session-Context': session.sessionContext! } }); await entered.promise; app.store.database.prepare('UPDATE auth_sessions SET expires_at = 0').run(); wait.resolve(result);
    const expired = await pending; assert.equal(expired.status, 401); assert.ok(!JSON.stringify(await expired.json()).includes('PRIVATE'));
  } finally { await app.close(); }
});

test('blame disconnect and application shutdown abort observers even when they never settle', async () => {
  let entered = deferred<AbortSignal>(); const app = await start({ blame: async (_id, _commit, _path, signal) => { assert.ok(signal); entered.resolve(signal); return new Promise<never>(() => undefined); } });
  try {
    const request = httpRequest(app.url(route)); request.on('error', () => undefined); request.end(); const first = await entered.promise;
    const aborted = new Promise<void>(resolve => first.addEventListener('abort', () => resolve(), { once: true })); request.destroy(); await aborted; assert.equal(first.aborted, true);
    entered = deferred<AbortSignal>(); const pending = app.request(route); const second = await entered.promise; await app.close(); assert.equal(second.aborted, true); assert.equal((await pending).body.code, 'GIT_ABORTED');
  } finally { await app.close(); }
});
