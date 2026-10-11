import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from './app.ts';
import { createAuth } from './auth.ts';
import { createStore } from './store.ts';
import type { GitObserver } from './git.ts';
import { HttpError } from './validation.ts';
import type { GitBlob, GitCommit, GitHistory, RepositoryDetail } from '../shared/repositories.ts';
import type { SessionState } from '../shared/auth.ts';
import { createGitFixture } from '../tests/git-fixture.ts';

const commit = 'a'.repeat(40); const tree = 'b'.repeat(40); const blob = 'c'.repeat(40);
const person = { name: 'Author', email: 'author@example.test', timestamp: '2026-01-01T00:00:00.000Z' };
const sourceCommit: GitCommit = { id: commit, treeId: tree, parentIds: [], author: person, committer: person, message: 'Immutable source', messageTruncated: false };
const identity = { repositoryId: 'R1', objectFormat: 'sha1' as const };
const textBlob: GitBlob = { ...identity, commitId: commit, path: 'src/a b.ts', objectId: blob, mode: '100644', size: 5, state: 'text', content: 'hello' };
const selected = (...principalIds: string[]) => ({ kind: 'principals' as const, principalIds });
type ErrorBody = { error: string; code?: string };

function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function observer(overrides: Partial<GitObserver> = {}): GitObserver {
  return {
    importSnapshot: async () => { throw new HttpError(422, 'Import is unavailable in this fixture.', 'GIT_IMPORT_UNSUPPORTED'); },
    compare: async () => { throw new HttpError(503, 'Comparison is unavailable in this fixture.', 'GIT_UNAVAILABLE'); },
    compareFile: async () => { throw new HttpError(503, 'Comparison is unavailable in this fixture.', 'GIT_UNAVAILABLE'); },
    patch: async () => { throw new HttpError(503, 'Patch is unavailable in this fixture.', 'GIT_UNAVAILABLE'); },
    blame: async () => { throw new HttpError(503, 'Blame is unavailable in this fixture.', 'GIT_UNAVAILABLE'); },
    info: async () => ({ state: 'ready', objectFormat: 'sha1' }),
    refs: async () => ({ ...identity, observedAt: person.timestamp, headCommit: commit, refs: [{ name: 'refs/heads/main', kind: 'branch', objectId: commit, commitId: commit }] }),
    commit: async () => ({ ...identity, commit: sourceCommit }),
    tree: async (_id, selectedCommit, path) => ({ ...identity, commitId: selectedCommit, path, treeId: tree, entries: [{ name: 'a b.ts', path: 'src/a b.ts', objectId: blob, mode: '100644', type: 'file', size: 5 }] }),
    blob: async () => textBlob,
    history: async (_id, query) => ({ ...identity, commitId: query.commit, path: query.path ?? '', commits: [sourceCommit], nextAfter: null }),
    ...overrides,
  };
}

async function start(gitObserver?: GitObserver, password = false, basePath = '/') {
  const store = createStore({ path: ':memory:' });
  const operator = createAuth({ database: store.database, mode: 'local', basePath, provisioning: true });
  const alice = password ? await operator.createAccount({ username: 'alice', displayName: 'Alice', password: 'Alice repository testing password' }) : undefined;
  const bob = password ? await operator.createAccount({ username: 'bob', displayName: 'Bob', password: 'Bob repository testing password' }) : undefined;
  const app = createApp({ store, seed: false, basePath, authMode: password ? 'password' : 'local', ...(gitObserver ? { gitObserver } : {}) });
  const token = bob ? app.auth.createToken(bob.id, { name: 'Repository reader', scopes: ['read'] }) : undefined;
  const repo = store.createRepository({ name: 'Registered source', description: 'Observed locally', remoteUrl: 'https://example.invalid/must-not-fetch.git', defaultBranch: 'main' });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  async function request<T = ErrorBody>(path: string, bearer = token?.token) {
    const response = await fetch(origin + basePath.slice(0, -1) + path, { signal: AbortSignal.timeout(10_000), headers: bearer ? { Authorization: `Bearer ${bearer}` } : {} });
    return { status: response.status, body: await response.json() as T, headers: response.headers };
  }
  function policy(fields: Record<string, unknown>) {
    const current = app.policies.policy(repo.id, alice!.id);
    return app.policies.setPolicy(repo.id, { expectedVersion: current.version, spaceId: current.spaceId, ...current.rules, ...fields }, alice!.id);
  }
  let closed = false;
  return { ...app, alice, bob, token, repo, origin, request, policy, close: async () => { if (closed) return; closed = true; await app.close(); store.close(); } };
}

test('repository reads expose pinned objects and current access, including mounted paths and bounded history', async () => {
  let historyQuery: unknown; let blobPath: unknown;
  const app = await start(observer({ history: async (_id, query) => { historyQuery = query; return { ...identity, commitId: query.commit, path: query.path ?? '', commits: [sourceCommit], nextAfter: 2 }; }, blob: async (_id, _commit, path) => { blobPath = path; return textBlob; } }), false, '/phabricator/');
  try {
    const detail = await app.request<RepositoryDetail>('/api/repositories/R1');
    assert.equal(detail.status, 200); assert.equal(detail.body.repository.id, 'R1'); assert.equal(detail.body.observer.state, 'ready'); assert.equal(detail.body.access?.capabilities.view, true); assert.equal(detail.body.accessEpoch, app.policies.epoch());
    for (const path of ['/refs', `/commits/${commit}`, `/tree?commit=${commit}&path=src`]) {
      const result = await app.request<Record<string, unknown>>(`/api/repositories/R1${path}`);
      assert.equal(result.status, 200); assert.equal(result.body.repositoryId, 'R1'); assert.equal(result.body.accessEpoch, app.policies.epoch()); assert.equal(result.headers.get('cache-control'), 'no-store');
    }
    const file = await app.request<GitBlob>(`/api/repositories/R1/blob?commit=${commit}&path=src%2Fa%20b.ts`);
    assert.equal(file.status, 200); assert.equal(blobPath, 'src/a b.ts'); assert.deepEqual(file.body, { ...textBlob, accessEpoch: app.policies.epoch() });
    const history = await app.request<GitHistory>(`/api/repositories/R1/history?commit=${commit}&path=src&after=1&limit=1`);
    assert.equal(history.status, 200); assert.equal(history.body.nextAfter, 2); assert.deepEqual(historyQuery, { commit, path: 'src', after: 1, limit: 1 });
    assert.equal((await fetch(app.origin + '/api/repositories/R1')).status, 404);
  } finally { await app.close(); }
});

test('unconfigured repositories remain honest registry records and unsupported reads do not fetch their remote URL', async () => {
  const app = await start();
  try {
    const detail = await app.request<RepositoryDetail>('/api/repositories/R1');
    assert.equal(detail.status, 200); assert.equal(detail.body.observer.state, 'unconfigured');
    const refs = await app.request('/api/repositories/R1/refs');
    assert.equal(refs.status, 503); assert.equal(refs.body.code, 'GIT_UNAVAILABLE');
    assert.equal((await app.request('/api/repositories/R999')).status, 404);
  } finally { await app.close(); }
});

test('repository query validation rejects mutable refs, ambiguity, unsafe paths and unbounded history before Git', async () => {
  let calls = 0;
  const failed = async (): Promise<never> => { calls++; throw new Error('must not reach Git'); };
  const app = await start(observer({ info: failed, refs: failed, commit: failed, tree: failed, blob: failed, history: failed }));
  try {
    const invalid = ['', '/refs'].map(path => `${path}?unexpected=1`).concat([
      `/commits/${commit}?path=x`, '/commits/main', '/commits/HEAD', `/commits/${'A'.repeat(40)}`,
      '/tree', '/tree?commit=main', `/tree?commit=${commit}&commit=${commit}`, `/tree?commit=${commit}&path=a/../b`,
      `/tree?commit=${commit}&path=a//b`, `/tree?commit=${commit}&path=%00`, `/tree?commit=${commit}&path=/etc/passwd`,
      `/blob?commit=${commit}`, `/blob?commit=${commit}&path=`, `/blob?commit=${commit}&path=a&path=b`,
      `/history?commit=${commit}&limit=101`, `/history?commit=${commit}&limit=0`, `/history?commit=${commit}&after=-1`,
      `/history?commit=${commit}&after=100001`, `/history?commit=${commit}&after=1e2`, `/history?commit=${commit}&after=01`,
    ]);
    for (const path of invalid) assert.equal((await app.request(`/api/repositories/R1${path}`)).status, 400, path);
    assert.equal(calls, 0);
  } finally { await app.close(); }
});

test('repository and restrictive Space policies precede every Git lookup, with identical hidden/missing errors', async () => {
  let calls = 0;
  const app = await start(observer({ info: async () => { calls++; return { state: 'ready', objectFormat: 'sha1' }; } }), true);
  try {
    const visible = await app.request<RepositoryDetail>('/api/repositories/R1'); assert.equal(visible.status, 200); assert.equal(visible.body.access?.capabilities.view, true);
    app.policy({ view: selected(app.alice!.id), edit: selected(app.alice!.id) });
    const missing = await app.request('/api/repositories/R999');
    for (const path of ['', '/refs', `/commits/${commit}`, `/tree?commit=${commit}`, `/blob?commit=${commit}&path=a`, `/history?commit=${commit}`]) {
      const hidden = await app.request(`/api/repositories/R1${path}`); assert.equal(hidden.status, 404); assert.deepEqual(hidden.body, missing.body);
    }
    assert.equal(calls, 1);
    const space = app.policies.createSpace({ name: 'Restricted', view: selected(app.alice!.id), edit: selected(app.alice!.id) }, app.alice!.id);
    app.policy({ spaceId: space.id, view: { kind: 'workspace' } });
    assert.equal((await app.request('/api/repositories/R1')).status, 404); assert.equal(calls, 1);
    const noRead = app.auth.createToken(app.bob!.id, { name: 'Write only', scopes: ['write'] });
    assert.equal((await app.request('/api/repositories/R1', noRead.token)).status, 403);
  } finally { await app.close(); }
});

test('pending Git successes and failures recheck repository and Space access without holding a database transaction', async () => {
  let wait = deferred<GitBlob>(); let entered = deferred<void>();
  const app = await start(observer({ blob: async () => { entered.resolve(); return wait.promise; } }), true);
  try {
    const pending = app.request(`/api/repositories/R1/blob?commit=${commit}&path=a`);
    await entered.promise;
    assert.doesNotThrow(() => app.store.database.exec('BEGIN IMMEDIATE; ROLLBACK;'));
    app.policy({ view: selected(app.alice!.id), edit: selected(app.alice!.id) });
    wait.resolve(textBlob);
    const denied = await pending; assert.equal(denied.status, 404); assert.equal(denied.body.code, 'OBJECT_UNAVAILABLE'); assert.ok(!JSON.stringify(denied.body).includes('hello'));
    const space = app.policies.createSpace({ name: 'Initially shared', view: { kind: 'workspace' } }, app.alice!.id);
    app.policy({ spaceId: space.id, view: { kind: 'workspace' } });
    wait = deferred<GitBlob>(); entered = deferred<void>();
    const failing = app.request(`/api/repositories/R1/blob?commit=${commit}&path=a`);
    await entered.promise;
    app.policies.updateSpace(space.id, { expectedVersion: space.version, view: selected(app.alice!.id), edit: selected(app.alice!.id) }, app.alice!.id);
    wait.reject(new HttpError(404, 'Sensitive Git object failure', 'GIT_OBJECT_UNAVAILABLE'));
    const revoked = await failing; assert.equal(revoked.status, 404); assert.equal(revoked.body.code, 'OBJECT_UNAVAILABLE'); assert.ok(!JSON.stringify(revoked.body).includes('Sensitive'));
  } finally { await app.close(); }
});

test('pending Git reads recheck credential revocation, scope removal, account disable and error sanitization', async () => {
  let wait = deferred<GitBlob>(); let entered = deferred<void>();
  const app = await start(observer({ blob: async () => { entered.resolve(); return wait.promise; } }), true);
  try {
    for (const change of ['revoke', 'scope', 'disable'] as const) {
      const token = app.auth.createToken(app.bob!.id, { name: change, scopes: ['read'] });
      wait = deferred<GitBlob>(); entered = deferred<void>();
      const pending = app.request(`/api/repositories/R1/blob?commit=${commit}&path=a`, token.token); await entered.promise;
      if (change === 'revoke') app.auth.revokeToken(app.bob!.id, token.record.id);
      else if (change === 'scope') app.store.database.prepare('UPDATE auth_tokens SET scopes = ? WHERE id = ?').run('["write"]', token.record.id);
      else app.auth.setAccountDisabled(app.bob!.id, true);
      if (change === 'disable') wait.reject(new Error('/private/operator/path SECRET')); else wait.resolve(textBlob);
      const denied = await pending; assert.equal(denied.status, change === 'scope' ? 403 : 401); assert.ok(!JSON.stringify(denied.body).includes('SECRET'));
    }
    app.auth.setAccountDisabled(app.bob!.id, false);
    const token = app.auth.createToken(app.bob!.id, { name: 'Restored', scopes: ['read'] });
    wait = deferred<GitBlob>(); entered = deferred<void>();
    const pending = app.request(`/api/repositories/R1/blob?commit=${commit}&path=a`, token.token); await entered.promise; wait.reject(new Error('/private/operator/path SECRET'));
    const unavailable = await pending; assert.deepEqual(unavailable.body, { error: 'Repository contents are unavailable.', code: 'GIT_UNAVAILABLE' }); assert.equal(unavailable.status, 503);
  } finally { await app.close(); }
});

test('disconnects and application shutdown abort queued Git reads even if an injected observer never settles', async () => {
  let entered = deferred<AbortSignal>();
  const app = await start(observer({ blob: async (_id, _commit, _path, signal) => { assert.ok(signal); entered.resolve(signal); return new Promise<never>(() => undefined); } }));
  try {
    const req = httpRequest(`${app.origin}/api/repositories/R1/blob?commit=${commit}&path=a`);
    req.on('error', () => undefined); req.end();
    const first = await entered.promise; const aborted = new Promise<void>(resolve => first.addEventListener('abort', () => resolve(), { once: true })); req.destroy(); await aborted; assert.equal(first.aborted, true);
    entered = deferred<AbortSignal>();
    const pending = app.request(`/api/repositories/R1/blob?commit=${commit}&path=a`);
    const second = await entered.promise;
    await app.close(); assert.equal(second.aborted, true);
    assert.equal((await pending).body.code, 'GIT_ABORTED');
  } finally { await app.close(); }
});

test('browser repository reads require matching session context and recheck session expiry after Git', async () => {
  const wait = deferred<GitBlob>(); const entered = deferred<void>(); let calls = 0;
  const app = await start(observer({ blob: async () => { calls++; entered.resolve(); return wait.promise; } }), true);
  try {
    const bootstrap = await fetch(app.origin + '/api/session'); const challenge = await bootstrap.json() as SessionState;
    const login = await fetch(app.origin + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: app.origin, Cookie: bootstrap.headers.getSetCookie().map(value => value.split(';')[0]!).join('; '), 'X-CSRF-Token': challenge.csrfToken! }, body: JSON.stringify({ username: 'bob', password: 'Bob repository testing password' }) });
    assert.equal(login.status, 200); const session = await login.json() as SessionState;
    const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]!).join('; ');
    const url = `${app.origin}/api/repositories/R1/blob?commit=${commit}&path=a`;
    assert.equal((await fetch(url, { headers: { Cookie: cookie } })).status, 401);
    assert.equal((await fetch(url, { headers: { Cookie: cookie, 'X-Session-Context': 'old-tab-context' } })).status, 401); assert.equal(calls, 0);
    const pending = fetch(url, { headers: { Cookie: cookie, 'X-Session-Context': session.sessionContext! } });
    await entered.promise;
    app.store.database.prepare('UPDATE auth_sessions SET expires_at = 0').run();
    wait.resolve(textBlob);
    const expired = await pending; assert.equal(expired.status, 401); assert.ok(!JSON.stringify(await expired.json()).includes('hello'));
  } finally { await app.close(); }
});

test('child Git misses do not masquerade as lost repository access', async () => {
  const app = await start(observer({ commit: async () => { throw new HttpError(404, 'Git object is unavailable.', 'GIT_OBJECT_UNAVAILABLE'); } }));
  try {
    const missing = await app.request(`/api/repositories/R1/commits/${commit}`); assert.equal(missing.status, 404); assert.equal(missing.body.code, 'GIT_OBJECT_UNAVAILABLE');
    assert.equal((await app.request('/api/repositories/R1')).status, 200);
  } finally { await app.close(); }
});

test('configured bare repositories are observed through HTTP without mutable branch substitution or filesystem disclosure', async () => {
  const fixture = await createGitFixture();
  const app = createApp({ databasePath: ':memory:', seed: false, gitRepositories: { R1: fixture.barePath } });
  try {
    app.store.createRepository({ name: 'Fixture repository', remoteUrl: 'https://example.invalid/unused.git' });
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const read = async <T>(path: string) => { const result = await fetch(origin + '/api/repositories/R1' + path); assert.equal(result.status, 200); const body = await result.json() as T; assert.ok(!JSON.stringify(body).includes(fixture.barePath)); return body; };
    assert.equal((await read<RepositoryDetail>('')).observer.state, 'ready');
    const before = await read<GitBlob>(`/blob?commit=${fixture.head}&path=README.md`); assert.equal(before.state, 'text');
    await fixture.advanceMain('Later source\n');
    assert.deepEqual(await read<GitBlob>(`/blob?commit=${fixture.head}&path=README.md`), before);
    for (const [path, state] of [['binary.dat', 'binary'], ['oversized.txt', 'oversized'], ['invalid.txt', 'unsupported_encoding'], ['link', 'symlink'], ['module', 'submodule']]) {
      const file = await read<GitBlob>(`/blob?commit=${fixture.head}&path=${path}`); assert.equal(file.state, state); assert.ok(!('content' in file));
    }
    const history = await read<GitHistory>(`/history?commit=${fixture.head}&limit=1`); assert.equal(history.commits[0]?.id, fixture.head); assert.equal(history.nextAfter, 1);
  } finally { await app.close(); await fixture.close(); }
});
