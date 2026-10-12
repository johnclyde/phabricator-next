import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp } from './app.ts';
import { createAuth } from './auth.ts';
import { createStore } from './store.ts';
import type { SessionState } from '../shared/auth.ts';

const filters = { kind: 'paper', query: 'Private exact search', status: 'all', projectId: null, following: false, authored: true } as const;
type Reply = { error?: string; view?: { id: string; name: string; version: number }; deleted?: boolean };

async function fixture(basePath = '/') {
  const store = createStore({ path: ':memory:' });
  const provision = createAuth({ database: store.database, mode: 'local', basePath, provisioning: true });
  const password = 'Saved revision views security fixture password';
  const alice = await provision.createAccount({ username: 'alice', displayName: 'Alice', password });
  await provision.createAccount({ username: 'bob', displayName: 'Bob', password });
  const app = createApp({ store, seed: false, authMode: 'password', basePath });
  const writer = app.auth.createToken(alice.id, { name: 'Writer', scopes: ['read', 'write'] });
  const reader = app.auth.createToken(alice.id, { name: 'Reader', scopes: ['read'] });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const raw = async <T = Reply>(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`${origin}${basePath.replace(/\/$/, '')}${path}`, { method, signal: AbortSignal.timeout(15_000), headers: { 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as T, headers: response.headers };
  };
  const request = (path: string, method = 'GET', body?: unknown, token = writer.token, key?: string) => raw(path, method, body, { Authorization: `Bearer ${token}`, ...(key ? { 'Idempotency-Key': key } : {}) });
  const input = () => ({ name: 'Private view', filters, expectedAccessEpoch: app.policies.epoch() });
  const browser = async () => {
    const challenge = await raw<SessionState>('/api/session');
    const challengeCookie = challenge.headers.getSetCookie().map(value => value.split(';')[0]!).join('; ');
    const login = await raw<SessionState>('/api/login', 'POST', { username: 'alice', password }, { Cookie: challengeCookie, Origin: origin, 'X-CSRF-Token': challenge.body.csrfToken! });
    assert.equal(login.status, 200);
    return { Cookie: login.headers.getSetCookie().map(value => value.split(';')[0]!).join('; '), Origin: origin, 'X-Session-Context': login.body.sessionContext!, 'X-CSRF-Token': login.body.csrfToken! };
  };
  return { ...app, store, alice, writer, reader, raw, request, input, browser, close: async () => { await app.close(); store.close(); } };
}

for (const basePath of ['/', '/mounted/']) test(`saved-view receipts never bypass current token scope or revocation at ${basePath}`, async () => {
  const f = await fixture(basePath);
  try {
    const key = randomUUID(), input = f.input();
    const created = await f.request('/api/revision-views', 'POST', input, f.writer.token, key);
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal((await f.request('/api/revision-views', 'GET', undefined, f.reader.token)).status, 200);
    const denied = await f.request('/api/revision-views', 'POST', input, f.reader.token, key);
    assert.equal(denied.status, 403, 'A read token cannot obtain a successful write receipt, even for its own existing request.');
    f.auth.revokeToken(f.alice.id, f.writer.record.id);
    assert.equal((await f.request('/api/revision-views', 'POST', input, f.writer.token, key)).status, 401);
    assert.equal((await f.request(`/api/revision-views/${created.body.view!.id}`, 'GET', undefined, f.writer.token)).status, 401);
    assert.equal((await f.request(`/api/revision-views/${created.body.view!.id}`, 'GET', undefined, f.reader.token)).status, 200);
  } finally { await f.close(); }
});

test('disabling the saved-view owner retires reads and exact retries without deleting the saved definition', async () => {
  const f = await fixture();
  try {
    const key = randomUUID(), input = f.input();
    const created = await f.request('/api/revision-views', 'POST', input, f.writer.token, key);
    assert.equal(created.status, 200, JSON.stringify(created.body));
    f.auth.setAccountDisabled(f.alice.id, true);
    assert.equal((await f.request('/api/revision-views')).status, 401);
    assert.equal((await f.request('/api/revision-views', 'POST', input, f.writer.token, key)).status, 401);
    f.auth.setAccountDisabled(f.alice.id, false);
    const replacement = f.auth.createToken(f.alice.id, { name: 'After explicit account recovery', scopes: ['read', 'write'] });
    const restored = await f.request(`/api/revision-views/${created.body.view!.id}`, 'GET', undefined, replacement.token);
    assert.equal(restored.status, 200); assert.match(JSON.stringify(restored.body), /Private exact search/);
  } finally { await f.close(); }
});

test('saved-view browser writes retain ordinary CSRF and session-context fences even on receipt replay', async () => {
  const f = await fixture('/mounted/');
  try {
    const headers = await f.browser(), key = randomUUID(), input = f.input();
    const created = await f.raw('/api/revision-views', 'POST', input, { ...headers, 'Idempotency-Key': key });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const noCSRF = { ...headers, 'X-CSRF-Token': 'retired-context', 'Idempotency-Key': key };
    assert.equal((await f.raw('/api/revision-views', 'POST', input, noCSRF)).status, 403);
    assert.equal((await f.raw('/api/revision-views', 'POST', input, { ...headers, Origin: 'https://foreign.example', 'Idempotency-Key': key })).status, 403);
    assert.equal((await f.raw('/api/revision-views', 'POST', input, { ...headers, 'X-Session-Context': 'retired-context', 'Idempotency-Key': key })).status, 401);
    const loggedOut = await f.raw('/api/logout', 'POST', {}, headers); assert.equal(loggedOut.status, 200);
    assert.equal((await f.raw('/api/revision-views', 'POST', input, { ...headers, 'Idempotency-Key': key })).status, 401);
  } finally { await f.close(); }
});
