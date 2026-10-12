import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuth } from './auth.ts';
import { createApp } from './app.ts';
import { createStore } from './store.ts';
import { googleAuthConfiguration, googleAuthFromEnvironment, type GoogleIdentity } from './google-auth.ts';
import type { AuthProviders } from '../shared/google-auth.ts';
import type { SessionState } from '../shared/auth.ts';

const publicOrigin = 'https://workspace.example';
const password = 'a long fixture password for sign in';
const config = () => ({ projectId: 'fixture-workspace', apiKey: 'fixture-public-api-key-0123456789', authDomain: 'fixture-workspace.firebaseapp.com', appId: '1:12345:web:abcdef123456', accounts: { 'fixture-google-uid': 'alice' } });
const identity = (): GoogleIdentity => { const seconds = Math.floor(Date.now() / 1000); return { uid: 'fixture-google-uid', issuedAt: seconds, authenticatedAt: seconds, expiresAt: seconds + 3600 }; };
const pair = (cookie: string) => cookie.split(';')[0]!;
const status = (expected: number) => (error: unknown) => typeof error === 'object' && error !== null && 'status' in error && error.status === expected;
const req = (headers: Record<string, string> = {}, method = 'GET') => ({ method, headers: { host: 'workspace.example', ...headers } }) as IncomingMessage;

test('Google configuration is explicit, immutable, bounded and contains only supported Firebase fields', () => {
  assert.equal(googleAuthFromEnvironment({}), undefined);
  for (const raw of ['', 'null', 'false', '{}', '{bad', JSON.stringify({ ...config(), accounts: {} })]) assert.throws(() => googleAuthFromEnvironment({ APP_GOOGLE_AUTH: raw }), /APP_GOOGLE_AUTH/);
  for (const value of [
    { ...config(), projectId: '../elsewhere' }, { ...config(), authDomain: 'other-project.firebaseapp.com' }, { ...config(), authDomain: 'https://fixture-workspace.firebaseapp.com' },
    { ...config(), apiKey: 'short' }, { ...config(), appId: 'wrong' }, { ...config(), accounts: { uid: 'Alice' } }, { ...config(), accounts: [] },
    { ...config(), accounts: { '': 'alice' } }, { ...config(), accounts: { ['x'.repeat(129)]: 'alice' } }, { ...config(), jwksURL: 'https://attacker.example/keys' },
    { ...config(), accounts: Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [`uid-${i}`, 'alice'])) },
  ]) assert.throws(() => googleAuthConfiguration(value), /APP_GOOGLE_AUTH/);
  const input = config(), copied = googleAuthConfiguration(input);
  input.accounts['fixture-google-uid'] = 'bob'; input.projectId = 'mutated-project';
  assert.equal(copied.accounts['fixture-google-uid'], 'alice'); assert.equal(copied.projectId, 'fixture-workspace');
  assert.ok(Object.isFrozen(copied)); assert.ok(Object.isFrozen(copied.accounts));
  assert.deepEqual(googleAuthFromEnvironment({ APP_GOOGLE_AUTH: JSON.stringify(config()) }), googleAuthConfiguration(config()));
});

test('Google configuration requires HTTPS password hosting and existing mapping; disabled mappings preserve other login methods on restart', async () => {
  const store = createStore({ path: ':memory:' });
  try {
    const provisioner = createAuth({ database: store.database, mode: 'local', basePath: '/', provisioning: true });
    const alice = await provisioner.createAccount({ username: 'alice', displayName: 'Alice', password });
    await provisioner.createAccount({ username: 'bob', displayName: 'Bob', password });
    const options = { database: store.database, basePath: '/', googleAuth: config() };
    assert.throws(() => createAuth({ ...options, mode: 'local' }), /APP_GOOGLE_AUTH/);
    assert.throws(() => createAuth({ ...options, mode: 'password' }), /APP_GOOGLE_AUTH/);
    assert.throws(() => createAuth({ ...options, mode: 'password', publicOrigin: 'http://workspace.example' }), /APP_PUBLIC_ORIGIN/);
    assert.throws(() => createAuth({ ...options, mode: 'password', publicOrigin, googleAuth: { ...config(), accounts: { uid: 'missing' } } }), /existing workspace account/);
    provisioner.setAccountDisabled(alice.id, true);
    const auth = createAuth({ ...options, mode: 'password', publicOrigin, googleTokenVerifier: async () => identity() });
    const challenge = auth.session(req()), headers = { cookie: pair(challenge.cookie!), origin: publicOrigin, 'x-csrf-token': challenge.session.csrfToken! };
    await assert.rejects(auth.loginGoogle(req(headers, 'POST'), 'test-only-provider-token'), status(401));
    const signed = await auth.login(req(headers, 'POST'), 'bob', password);
    assert.equal(signed.session.account!.username, 'bob');
  } finally { store.close(); }
});

interface Reply<T> { status: number; headers: IncomingHttpHeaders; body: T; text: string }
async function fixture(basePath: string, enabled = true) {
  const directory = await mkdtemp(join(tmpdir(), 'phab-google-auth-'));
  await writeFile(join(directory, 'index.html'), `<meta name="application-base" content="${basePath}"><h1>Sign in</h1>`);
  const store = createStore({ path: ':memory:' });
  const provisioner = createAuth({ database: store.database, mode: 'local', basePath, provisioning: true });
  const account = await provisioner.createAccount({ username: 'alice', displayName: 'Alice', password });
  let calls = 0;
  const app = createApp({ store, seed: false, basePath, authMode: 'password', publicOrigin, distPath: directory,
    ...(enabled ? { googleAuth: config(), googleTokenVerifier: async (token: string) => { calls++; assert.equal(token, 'test-only-provider-token'); return identity(); } } : {}),
  });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const port = (app.server.address() as AddressInfo).port;
  const request = <T = { error: string }>(path: string, method = 'GET', data?: unknown, headers: Record<string, string> = {}) => new Promise<Reply<T>>((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port, path: `${basePath}${path}`, method, headers: { Host: 'workspace.example', ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers } }, response => {
      const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(Buffer.from(chunk))); response.on('error', reject);
      response.on('end', () => { const text = Buffer.concat(chunks).toString(); let body: T; try { body = JSON.parse(text) as T; } catch { body = text as T; } resolve({ status: response.statusCode!, headers: response.headers, body, text }); });
    });
    request.on('error', reject); request.end(data === undefined ? undefined : JSON.stringify(data));
  });
  return { ...app, account, request, calls: () => calls, close: async () => { await app.close(); store.close(); await rm(directory, { recursive: true, force: true }); } };
}

for (const basePath of ['/', '/workspace/']) test(`Google bridge returns existing sessions and keeps public configuration/account secrets separated at ${basePath}`, async () => {
  const app = await fixture(basePath);
  try {
    const providers = await app.request<AuthProviders>('api/auth/providers');
    assert.equal(providers.status, 200); assert.equal(providers.headers['cache-control'], 'no-store');
    const { accounts: _accounts, ...web } = config(); assert.deepEqual(providers.body, { google: web });
    assert.ok(!providers.text.includes('fixture-google-uid')); assert.ok(!providers.text.includes('alice'));
    assert.equal((await app.request('api/auth/providers?anything=1')).status, 400);
    const shell = await app.request(''), csp = String(shell.headers['content-security-policy']);
    assert.match(csp, /script-src 'self' 'wasm-unsafe-eval' https:\/\/apis\.google\.com;/);
    assert.match(csp, /connect-src 'self' https:\/\/identitytoolkit\.googleapis\.com https:\/\/securetoken\.googleapis\.com;/);
    assert.match(csp, /frame-src https:\/\/fixture-workspace\.firebaseapp\.com/); assert.doesNotMatch(csp, /\*|\s'unsafe-eval'/);
    const challenge = await app.request<SessionState>('api/session'), challengeCookie = pair(challenge.headers['set-cookie']![0]!);
    const headers = { Cookie: challengeCookie, Origin: publicOrigin, 'X-CSRF-Token': challenge.body.csrfToken! };
    assert.equal((await app.request('api/login/google', 'POST', { idToken: 'test-only-provider-token', username: 'bob' }, headers)).status, 400);
    assert.equal((await app.request('api/login/google?token=secret', 'POST', { idToken: 'test-only-provider-token' }, headers)).status, 400);
    assert.equal((await app.request('api/login/google', 'POST', { idToken: 'x'.repeat(17_000) }, headers)).status, 413);
    assert.equal(app.calls(), 0);
    const signed = await app.request<SessionState>('api/login/google', 'POST', { idToken: 'test-only-provider-token' }, headers);
    assert.equal(signed.status, 200); assert.equal(signed.body.account!.id, app.account.id); assert.equal(signed.body.mode, 'password');
    const sessionCookie = pair(signed.headers['set-cookie']![0]!);
    assert.match(signed.headers['set-cookie']![0]!, /HttpOnly; SameSite=Strict; Max-Age=43200; Secure/);
    assert.ok(signed.headers['set-cookie']![0]!.includes(`Path=${basePath};`));
    assert.equal((await app.request('api/state', 'GET', undefined, { Cookie: sessionCookie })).status, 401);
    const sessionHeaders = { Cookie: `${challengeCookie}; ${sessionCookie}`, Origin: publicOrigin, 'X-Session-Context': signed.body.sessionContext!, 'X-CSRF-Token': signed.body.csrfToken! };
    assert.equal((await app.request('api/state', 'GET', undefined, sessionHeaders)).status, 200);
    assert.equal((await app.request('api/login/google', 'POST', { idToken: 'test-only-provider-token' }, headers)).status, 403);
    assert.equal((app.store.database.prepare('SELECT count(*) AS count FROM auth_accounts').get() as { count: number }).count, 1);
    const loggedOut = await app.request<SessionState>('api/logout', 'POST', {}, sessionHeaders);
    assert.equal(loggedOut.status, 200); assert.equal(loggedOut.body.account, null);
    const passwordLogin = await app.request<SessionState>('api/login', 'POST', { username: 'alice', password }, { ...headers, 'X-CSRF-Token': loggedOut.body.csrfToken! });
    assert.equal(passwordLogin.status, 200); assert.equal(passwordLogin.body.account!.id, app.account.id);
    for (const table of ['auth_accounts', 'auth_sessions', 'auth_challenges', 'auth_login_limits']) assert.ok(!JSON.stringify(app.store.database.prepare(`SELECT * FROM ${table}`).all()).includes('test-only-provider-token'));
  } finally { await app.close(); }
});

test('unconfigured workspaces expose no provider and retain their original restrictive CSP', async () => {
  const app = await fixture('/', false);
  try {
    assert.deepEqual((await app.request<AuthProviders>('api/auth/providers')).body, { google: null });
    const csp = String((await app.request('')).headers['content-security-policy']);
    assert.doesNotMatch(csp, /googleapis|firebaseapp|frame-src/);
    assert.equal((await app.request('api/login/google', 'POST', { idToken: 'test-only-provider-token' }, { Origin: publicOrigin })).status, 400);
  } finally { await app.close(); }
});
