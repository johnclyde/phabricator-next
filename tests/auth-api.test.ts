import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { createApp, type AppOptions } from '../server/app.ts';
import { createAuth } from '../server/auth.ts';
import { createStore } from '../server/store.ts';
import type { SessionState } from '../shared/auth.ts';
import type { AppState, ReviewAnalysis, ReviewComment, RevisionDetail, Task, WikiDocument, WikiVersion } from '../shared/types.ts';

const password = 'A long test-only password for workspace access';
const revisionInput = { testPlan: 'Fixture verification plan.', title: 'Authenticated paper', kind: 'paper', files: [{ path: 'main.tex', content: '\\section{Introduction}\nAn explicit source snapshot.\n' }] };

type Reply<T> = { status: number; body: T; headers: Headers };

async function start(options: AppOptions = {}) {
  const store = createStore({ path: options.databasePath ?? ':memory:' });
  const basePath = options.basePath ?? '/';
  const provisioning = createAuth({ database: store.database, mode: 'local', basePath, provisioning: true });
  const alice = await provisioning.createAccount({ username: 'alice', displayName: 'Alice Researcher', password });
  const bob = await provisioning.createAccount({ username: 'bob', displayName: 'Bob Researcher', password });
  const app = createApp({ ...options, store, seed: false, authMode: 'password' });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const raw = async <T = { error: string }>(path: string, method = 'GET', data?: unknown, headers: Record<string, string> = {}): Promise<Reply<T>> => {
    const response = await fetch(`${origin}${basePath}${path.replace(/^\//, '')}`, {
      method, signal: AbortSignal.timeout(15_000),
      headers: { ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    return { status: response.status, body: await response.json() as T, headers: response.headers };
  };
  const browser = () => {
    const cookies = new Map<string, string>();
    let session: SessionState | undefined;
    const acceptCookies = (headers: Headers): void => {
      for (const cookie of headers.getSetCookie()) {
        const pair = cookie.split(';')[0]!;
        const separator = pair.indexOf('=');
        const name = pair.slice(0, separator);
        if (/max-age=0(?:;|$)/i.test(cookie) || !pair.slice(separator + 1)) cookies.delete(name);
        else cookies.set(name, pair.slice(separator + 1));
      }
    };
    const cookieHeader = () => [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    const headers = (): Record<string, string> => ({
      Cookie: cookieHeader(),
      Origin: origin,
      ...(session?.csrfToken ? { 'X-CSRF-Token': session.csrfToken } : {}),
      ...(session?.sessionContext ? { 'X-Session-Context': session.sessionContext } : {}),
    });
    const request = async <T = { error: string }>(path: string, method = 'GET', data?: unknown, overrides: Record<string, string> = {}) => {
      const result = await raw<T>(path, method, data, { ...headers(), ...overrides });
      acceptCookies(result.headers);
      return result;
    };
    const login = async (username: string): Promise<Reply<SessionState>> => {
      const boot = await request<SessionState>('/api/session');
      assert.equal(boot.status, 200);
      session = boot.body;
      const result = await request<SessionState>('/api/login', 'POST', { username, password });
      assert.equal(result.status, 200);
      session = result.body;
      assert.ok(session.csrfToken);
      assert.ok(session.sessionContext);
      return result;
    };
    return { request, login, headers, cookieHeader, get session() { return session; } };
  };
  return {
    ...app, alice, bob, origin, basePath, raw, browser,
    close: async () => { await app.close(); store.close(); },
  };
}

test('password mode denies anonymous workspace reads and mutations before looking up objects', async () => {
  const app = await start();
  try {
    for (const path of ['/api/state', '/api/documents/W1', '/api/documents/W1/history', '/api/documents/W1/versions/1', '/api/revisions/P1', '/api/revisions/P1/export']) {
      assert.equal((await app.raw(path)).status, 401, path);
    }
    assert.equal((await app.raw('/api/tasks', 'POST', { title: 'Anonymous write' })).status, 401);
    assert.equal((await app.raw('/api/health')).status, 200);
    const client = app.browser();
    await client.login('alice');
    const state = await client.request<AppState>('/api/state');
    assert.equal(state.status, 200);
    assert.equal(state.body.tasks.length, 0);
  } finally { await app.close(); }
});

test('session context, CSRF, origin and credential kind are enforced independently', async () => {
  const app = await start();
  try {
    const bootstrap = await app.raw<SessionState>('/api/session');
    assert.equal(bootstrap.status, 200);
    assert.equal(bootstrap.body.account, null);
    assert.equal(bootstrap.headers.get('Cache-Control'), 'no-store');
    const challenge = bootstrap.headers.getSetCookie().map(value => value.split(';')[0]!).join('; ');
    const login = { username: 'alice', password };
    assert.equal((await app.raw('/api/login', 'POST', login, { Cookie: challenge, Origin: app.origin })).status, 403);
    assert.equal((await app.raw('/api/login', 'POST', login, { Cookie: challenge, Origin: app.origin, 'X-CSRF-Token': 'wrong-challenge' })).status, 403);
    assert.equal((await app.raw('/api/login', 'POST', login, { Cookie: challenge, 'X-CSRF-Token': bootstrap.body.csrfToken! })).status, 403);
    const client = app.browser();
    await client.login('alice');
    const cookie = client.cookieHeader();
    assert.equal((await app.raw('/api/state', 'GET', undefined, { Cookie: cookie })).status, 401);
    assert.equal((await client.request('/api/state', 'GET', undefined, { 'X-Session-Context': 'wrong-session-context' })).status, 401);
    assert.equal((await client.request('/api/tasks', 'POST', { title: 'No CSRF' }, { 'X-CSRF-Token': '' })).status, 403);
    assert.equal((await client.request('/api/tasks', 'POST', { title: 'Wrong CSRF' }, { 'X-CSRF-Token': 'wrong-token' })).status, 403);
    assert.equal((await client.request('/api/tasks', 'POST', { title: 'Cross origin' }, { Origin: 'https://attacker.example' })).status, 403);
    assert.equal((await client.request('/api/tasks', 'POST', { title: 'Opaque origin' }, { Origin: 'null' })).status, 403);
    assert.equal((await client.request('/api/state', 'GET', undefined, { Authorization: 'Bearer invalid-mixed-token' })).status, 401);
    const created = await client.request<Task>('/api/tasks', 'POST', { title: 'Authorized write' });
    assert.equal(created.status, 201);
    assert.equal((await client.request<AppState>('/api/state')).body.tasks.length, 1);
  } finally { await app.close(); }
});

test('new history names its principal and idempotency keys never cross account boundaries', async () => {
  const app = await start();
  try {
    const alice = app.browser(); const bob = app.browser();
    await alice.login('alice'); await bob.login('bob');
    const data = { title: 'The same request under different identities' };
    const headers = { 'Idempotency-Key': 'shared-client-key' };
    const first = await alice.request<Task>('/api/tasks', 'POST', data, headers);
    const replay = await alice.request<Task>('/api/tasks', 'POST', data, headers);
    const second = await bob.request<Task>('/api/tasks', 'POST', data, headers);
    assert.equal(first.status, 201); assert.deepEqual(replay.body, first.body);
    assert.equal(second.status, 201); assert.notEqual(second.body.id, first.body.id);
    const state = (await alice.request<AppState>('/api/state')).body;
    // This milestone intentionally shares the workspace between members. It
    // isolates mutation identity, not individual objects or Spaces yet.
    assert.equal(state.tasks.length, 2);
    const aliceEvent = state.activity.find(item => item.objectId === first.body.id)!;
    const bobEvent = state.activity.find(item => item.objectId === second.body.id)!;
    assert.equal(aliceEvent.actor, 'Alice Researcher');
    assert.equal(aliceEvent.attribution?.principalId, app.alice.id);
    assert.equal(bobEvent.actor, 'Bob Researcher');
    assert.equal(bobEvent.attribution?.principalId, app.bob.id);
    assert.ok(aliceEvent.attribution?.requestId);
    assert.notEqual(aliceEvent.attribution?.credentialId, bobEvent.attribution?.credentialId);
    const revision = (await alice.request<RevisionDetail>('/api/revisions', 'POST', revisionInput)).body;
    assert.equal(revision.versions[0]!.attribution?.principalId, app.alice.id);
    const comment = (await bob.request<ReviewComment>(`/api/revisions/${revision.revision.id}/comments`, 'POST', { versionId: revision.versions[0]!.id, body: 'An attributed response.' })).body;
    assert.equal(comment.author, 'Bob Researcher'); assert.equal(comment.attribution?.principalId, app.bob.id);
    const document = (await alice.request<WikiDocument>('/api/documents', 'POST', { title: 'Attributed wiki', slug: '/', content: 'Preserve the writer.' })).body;
    const version = (await bob.request<WikiVersion>(`/api/documents/${document.id}/versions/1`)).body;
    assert.equal(version.attribution?.principalId, app.alice.id);
  } finally { await app.close(); }
});

test('logging out revokes the cookie and blocks an already committed response replay', async () => {
  const app = await start();
  try {
    const client = app.browser();
    await client.login('alice');
    const headers = { ...client.headers(), 'Idempotency-Key': 'cannot-replay-after-logout' };
    const data = { title: 'Private mutation response' };
    assert.equal((await app.raw('/api/tasks', 'POST', data, headers)).status, 201);
    assert.equal((await client.request('/api/logout', 'POST', {})).status, 200);
    assert.equal((await app.raw('/api/state', 'GET', undefined, headers)).status, 401);
    assert.equal((await app.raw('/api/tasks', 'POST', data, headers)).status, 401);
    await client.login('alice');
    assert.equal((await client.request<AppState>('/api/state')).body.tasks.length, 1);
  } finally { await app.close(); }
});

test('session cookies stay within each root or mounted application path', async () => {
  for (const basePath of ['/', '/workspace/']) {
    const app = await start({ basePath });
    try {
      const client = app.browser();
      const login = await client.login('alice');
      const cookies = login.headers.getSetCookie().filter(value => !/Max-Age=0/i.test(value));
      assert.ok(cookies.length);
      for (const cookie of cookies) {
        assert.ok(cookie.split(';').some(part => part.trim() === `Path=${basePath}`));
        assert.match(cookie, /;\s*HttpOnly(?:;|$)/i);
        assert.match(cookie, /;\s*SameSite=(?:Lax|Strict)(?:;|$)/i);
        assert.doesNotMatch(cookie, /;\s*Domain=/i);
      }
      assert.equal((await client.request('/api/state')).status, 200);
      if (basePath !== '/') {
        const outside = await fetch(`${app.origin}/api/state`, { headers: client.headers() });
        assert.equal(outside.status, 404);
      }
    } finally { await app.close(); }
  }
});

test('bearer scopes restrict writes and hosted review even when another credential has replay evidence', async () => {
  let providerCalls = 0;
  const analysis: ReviewAnalysis = { provider: 'openai', model: 'test-model', summary: 'A mocked provider response.', findings: [] };
  const app = await start({ aiConfiguration: () => ({ configured: true, model: 'test-model' }), analyzeAI: async () => { providerCalls += 1; return analysis; } });
  try {
    const client = app.browser(); await client.login('alice');
    const revision = (await client.request<RevisionDetail>('/api/revisions', 'POST', revisionInput)).body;
    const reader = app.auth.createToken(app.alice.id, { name: 'Read only', scopes: ['read'] });
    const reviewer = app.auth.createToken(app.alice.id, { name: 'Local checks only', scopes: ['read', 'review:local'] });
    const readonlyHeaders = { Authorization: `Bearer ${reader.token}` };
    const localHeaders = { Authorization: `Bearer ${reviewer.token}` };
    assert.equal((await app.raw('/api/state', 'GET', undefined, readonlyHeaders)).status, 200);
    assert.equal((await app.raw('/api/tasks', 'POST', { title: 'Forbidden write' }, readonlyHeaders)).status, 403);
    const path = `/api/revisions/${revision.revision.id}/reviews`;
    assert.equal((await app.raw(path, 'POST', { provider: 'local', expectedVersion: 1 }, readonlyHeaders)).status, 403);
    assert.equal((await app.raw(path, 'POST', { provider: 'local', expectedVersion: 1 }, localHeaders)).status, 201);
    const hosted = { provider: 'openai', expectedVersion: 1 };
    const replayKey = { 'Idempotency-Key': 'hosted-evidence-needs-hosted-scope' };
    assert.equal((await client.request(path, 'POST', hosted, replayKey)).status, 201);
    assert.equal(providerCalls, 1);
    assert.equal((await app.raw(path, 'POST', hosted, { ...localHeaders, ...replayKey })).status, 403);
    assert.equal(providerCalls, 1);
    const evidence = (await client.request<RevisionDetail>(`/api/revisions/${revision.revision.id}`)).body.reviews;
    assert.equal(evidence.length, 2);
    assert.equal(evidence.find(item => item.provider === 'local')?.attribution?.credentialId, reviewer.record.id);
    assert.equal(evidence.find(item => item.provider === 'openai')?.attribution?.principalId, app.alice.id);
  } finally { await app.close(); }
});

test('revoked tokens and disabled accounts cannot read or replay earlier writes', async () => {
  const app = await start();
  try {
    const writer = app.auth.createToken(app.alice.id, { name: 'Writer', scopes: ['read', 'write'] });
    const headers = { Authorization: `Bearer ${writer.token}`, 'Idempotency-Key': 'revocation-response' };
    const data = { title: 'Previously authorized' };
    assert.equal((await app.raw('/api/tasks', 'POST', data, headers)).status, 201);
    app.auth.revokeToken(app.alice.id, writer.record.id);
    assert.equal((await app.raw('/api/state', 'GET', undefined, headers)).status, 401);
    assert.equal((await app.raw('/api/tasks', 'POST', data, headers)).status, 401);
    const browser = app.browser(); await browser.login('alice');
    const sessionHeaders = { ...browser.headers(), 'Idempotency-Key': 'disabled-session-response' };
    assert.equal((await app.raw('/api/tasks', 'POST', { title: 'Before account disable' }, sessionHeaders)).status, 201);
    const otherToken = app.auth.createToken(app.alice.id, { name: 'Also revoked by disable', scopes: ['read'] });
    app.auth.setAccountDisabled(app.alice.id, true);
    assert.equal((await app.raw('/api/state', 'GET', undefined, sessionHeaders)).status, 401);
    assert.equal((await app.raw('/api/tasks', 'POST', { title: 'Before account disable' }, sessionHeaders)).status, 401);
    assert.equal((await app.raw('/api/state', 'GET', undefined, { Authorization: `Bearer ${otherToken.token}` })).status, 401);
    const bob = app.browser(); await bob.login('bob');
    assert.equal((await bob.request<AppState>('/api/state')).body.tasks.length, 2);
  } finally { await app.close(); }
});

test('revoking a token while AI is running prevents both evidence and replay from being committed', async () => {
  let begin!: () => void;
  let complete!: (result: ReviewAnalysis) => void;
  const began = new Promise<void>(resolve => { begin = resolve; });
  const result = new Promise<ReviewAnalysis>(resolve => { complete = resolve; });
  const analysis: ReviewAnalysis = { provider: 'openai', model: 'test-model', summary: 'This should never become saved evidence.', findings: [] };
  const app = await start({ aiConfiguration: () => ({ configured: true, model: 'test-model' }), analyzeAI: async () => { begin(); return result; } });
  try {
    const browser = app.browser(); await browser.login('alice');
    const revision = (await browser.request<RevisionDetail>('/api/revisions', 'POST', revisionInput)).body;
    const reviewer = app.auth.createToken(app.alice.id, { name: 'Revocable reviewer', scopes: ['read', 'review:hosted'] });
    const path = `/api/revisions/${revision.revision.id}/reviews`;
    const body = { provider: 'openai', expectedVersion: 1 };
    const headers = { Authorization: `Bearer ${reviewer.token}`, 'Idempotency-Key': 'revoked-during-model-run' };
    const pending = app.raw(path, 'POST', body, headers);
    await Promise.race([began, pending.then(response => { throw new Error(`Review returned ${response.status} before the provider began.`); })]);
    app.auth.revokeToken(app.alice.id, reviewer.record.id);
    complete(analysis);
    assert.equal((await pending).status, 401);
    assert.equal((await app.raw(path, 'POST', body, headers)).status, 401);
    const detail = (await browser.request<RevisionDetail>(`/api/revisions/${revision.revision.id}`)).body;
    assert.equal(detail.reviews.length, 0);
    assert.equal(detail.activity.filter(item => item.action === 'reviewed').length, 0);
    assert.equal((app.store.database.prepare('SELECT count(*) AS count FROM idempotency').get() as { count: number }).count, 0);
  } finally { complete(analysis); await app.close(); }
});

test('revocation committed while acquiring the write lock blocks mutations, AI evidence and newly visible replay', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'phabricator-auth-lock-'));
  const databasePath = join(directory, 'workspace.sqlite');
  let providerCalls = 0;
  const app = await start({
    databasePath,
    aiConfiguration: () => ({ configured: true, model: 'test-model' }),
    analyzeAI: async () => { providerCalls += 1; return { provider: 'openai', model: 'test-model', summary: 'Must not be saved after revocation.', findings: [] }; },
  });
  const transaction = app.store.transaction.bind(app.store);
  try {
    const browser = app.browser(); await browser.login('alice');
    const revision = (await browser.request<RevisionDetail>('/api/revisions', 'POST', revisionInput)).body;
    for (const phase of ['write', 'ai', 'replay'] as const) {
      const credential = app.auth.createToken(app.alice.id, { name: `Concurrent ${phase}`, scopes: ['read', 'write', 'review:hosted'] });
      const headers = { Authorization: `Bearer ${credential.token}`, 'Idempotency-Key': `locked-revocation-${phase}` };
      const path = phase === 'ai' ? `/api/revisions/${revision.revision.id}/reviews` : '/api/tasks';
      const body = phase === 'ai' ? { provider: 'openai', expectedVersion: 1 } : { title: `Concurrent ${phase}` };
      let replay: { key: string; fingerprint: string; status: number; body: string; created_at: string } | undefined;
      if (phase === 'replay') {
        assert.equal((await app.raw(path, 'POST', body, headers)).status, 201);
        replay = app.store.database.prepare('SELECT * FROM idempotency ORDER BY created_at DESC LIMIT 1').get() as typeof replay;
        assert.ok(replay);
        // Delay visibility of a real committed response until the competing
        // transaction commits, without duplicating the fingerprint algorithm.
        app.store.database.prepare('DELETE FROM idempotency WHERE key = ?').run(replay.key);
      }
      const taskCount = (await browser.request<AppState>('/api/state')).body.tasks.length;
      const activityCount = app.store.activities().length;
      const replayCount = (app.store.database.prepare('SELECT count(*) AS count FROM idempotency').get() as { count: number }).count;
      const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(`
        import { parentPort, workerData } from 'node:worker_threads';
        import { DatabaseSync } from 'node:sqlite';
        const database = new DatabaseSync(workerData.databasePath);
        database.exec('PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE');
        database.prepare('UPDATE auth_tokens SET revoked = 1 WHERE id = ?').run(workerData.tokenId);
        if (workerData.replay) {
          const row = workerData.replay;
          database.prepare('INSERT INTO idempotency (key, fingerprint, status, body, created_at) VALUES (?, ?, ?, ?, ?)').run(row.key, row.fingerprint, row.status, row.body, row.created_at);
        }
        parentPort.once('message', () => {
          database.exec('COMMIT'); database.close(); parentPort.close();
        });
        parentPort.postMessage('locked');
      `)}`), { workerData: { databasePath, tokenId: credential.record.id, replay } });
      let workerFailure: Error | undefined;
      worker.on('error', error => { workerFailure = error; });
      let entered = 0;
      try {
        assert.deepEqual(await once(worker, 'message'), ['locked']);
        // WAL readers still see an authorized token and no newly published
        // replay. Release the real competing SQLite transaction only after
        // HTTP prechecks, exactly when this request starts acquiring its lock.
        app.store.transaction = function<T>(work: () => T): T {
          entered += 1; app.store.transaction = transaction;
          worker.postMessage('commit');
          return transaction(work);
        };
        const response = await app.raw(path, 'POST', body, headers);
        assert.equal(workerFailure, undefined);
        assert.equal(entered, 1, `${phase} must reach the write-lock boundary`);
        assert.equal(response.status, 401, phase);
        assert.deepEqual(Object.keys(response.body), ['error']);
        assert.equal((await browser.request<AppState>('/api/state')).body.tasks.length, taskCount, phase);
        assert.equal(app.store.detail(revision.revision.id).reviews.length, 0, phase);
        assert.equal(app.store.activities().length, activityCount, phase);
        assert.equal((app.store.database.prepare('SELECT count(*) AS count FROM idempotency').get() as { count: number }).count, replayCount + (phase === 'replay' ? 1 : 0), phase);
        assert.equal(app.auth.listTokens(app.alice.id).find(token => token.id === credential.record.id)?.revoked, true);
      } finally {
        app.store.transaction = transaction;
        await worker.terminate();
      }
    }
    assert.equal(providerCalls, 1, 'The AI request reached its provider before the competing revocation committed.');
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
