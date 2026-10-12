import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.ts';
import { createAuth } from '../server/auth.ts';
import { createStore } from '../server/store.ts';
import type { SessionState } from '../shared/auth.ts';
import type { AppState, Task, WikiDocument } from '../shared/types.ts';
import type { FileRecord } from '../shared/files.ts';

const publicOrigin = 'https://workspace.example:8443';
const password = 'the hosted fixture has a long password';
const pair = (cookie: string) => cookie.split(';')[0]!;
interface Reply<T> { status: number; headers: IncomingHttpHeaders; text: string; body: T }

async function fixture(basePath: string) {
  const directory = await mkdtemp(join(tmpdir(), 'phab-hosted-auth-'));
  await writeFile(join(directory, 'index.html'), `<meta name="application-base" content="${basePath}"><h1>Workspace sign-in shell</h1>`);
  await mkdir(join(directory, 'assets'));
  await writeFile(join(directory, 'assets', 'app-fixture.js'), 'export const fixture = true;');
  const store = createStore({ path: ':memory:' });
  const provisioner = createAuth({ database: store.database, mode: 'local', basePath, provisioning: true });
  const account = await provisioner.createAccount({ username: 'alice', displayName: 'Alice Hosted', password });
  const app = createApp({ store, seed: false, basePath, authMode: 'password', publicOrigin, distPath: directory });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const port = (app.server.address() as AddressInfo).port;
  const request = <T = { error: string }>(path: string, method = 'GET', data?: unknown, headers: Record<string, string> = {}) => new Promise<Reply<T>>((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port, path, method, headers: { Host: new URL(publicOrigin).host, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => { const text = Buffer.concat(chunks).toString(); let body: T; try { body = JSON.parse(text) as T; } catch { body = text as T; } resolve({ status: response.statusCode!, headers: response.headers, text, body }); });
      response.on('error', reject);
    });
    request.on('error', reject); request.end(data === undefined ? undefined : JSON.stringify(data));
  });
  return { ...app, account, request, close: async () => { await app.close(); store.close(); await rm(directory, { recursive: true, force: true }); } };
}

for (const basePath of ['/', '/workspace/']) test(`hosted password sessions, cookies, scoped tokens and private downloads work at ${basePath}`, async () => {
  const app = await fixture(basePath), route = (path: string) => `${basePath}${path}`;
  try {
    const shell = await app.request(route(''));
    assert.equal(shell.status, 200); assert.equal(shell.headers['cache-control'], 'no-cache'); assert.match(String(shell.headers['content-security-policy']), /frame-ancestors 'none'/);
    const asset = await app.request(route('assets/app-fixture.js'));
    assert.equal(asset.status, 200); assert.match(asset.headers['cache-control']!, /immutable/);
    const anonymous = await app.request(route('api/state'));
    assert.equal(anonymous.status, 401); assert.equal(anonymous.headers['cache-control'], 'no-store');
    const challenge = await app.request<SessionState>(route('api/session'));
    assert.equal(challenge.status, 200); assert.equal(challenge.body.mode, 'password'); assert.equal(challenge.body.account, null); assert.equal(challenge.headers['cache-control'], 'no-store');
    const challengeCookie = challenge.headers['set-cookie']![0]!;
    assert.ok(challengeCookie.includes(`; Path=${basePath}; HttpOnly; SameSite=Strict; Max-Age=600; Secure`)); assert.doesNotMatch(challengeCookie, /Domain=/i);
    const loginHeaders = { Cookie: pair(challengeCookie), 'X-CSRF-Token': challenge.body.csrfToken! };
    for (const origin of [undefined, 'null', 'http://workspace.example:8443', 'https://sibling.example:8443']) {
      const rejected = await app.request(route('api/login'), 'POST', { username: 'alice', password }, { ...loginHeaders, ...(origin === undefined ? {} : { Origin: origin }) });
      assert.equal(rejected.status, 403); assert.equal(rejected.headers['set-cookie'], undefined);
    }
    assert.equal((await app.request(route('api/login'), 'POST', { username: 'alice', password }, { ...loginHeaders, Origin: publicOrigin, 'X-CSRF-Token': 'wrong' })).status, 403);
    const signed = await app.request<SessionState>(route('api/login'), 'POST', { username: 'alice', password }, {
      ...loginHeaders, Origin: publicOrigin, Forwarded: 'host=attacker.example;proto=http', 'X-Forwarded-Host': 'attacker.example', 'X-Forwarded-Proto': 'http',
    });
    assert.equal(signed.status, 200); assert.equal(signed.body.account!.id, app.account.id); assert.equal(signed.headers['cache-control'], 'no-store');
    const sessionCookie = signed.headers['set-cookie']![0]!;
    assert.ok(sessionCookie.includes(`; Path=${basePath}; HttpOnly; SameSite=Strict; Max-Age=43200; Secure`)); assert.doesNotMatch(sessionCookie, /Domain=/i);
    const sessionHeaders = { Cookie: pair(sessionCookie), 'X-Session-Context': signed.body.sessionContext! };
    assert.equal((await app.request(route('api/state'), 'GET', undefined, { Cookie: pair(sessionCookie) })).status, 401);
    const state = await app.request<AppState>(route('api/state'), 'GET', undefined, sessionHeaders);
    assert.equal(state.status, 200); assert.equal(state.body.currentPrincipalId, app.account.id); assert.equal(state.headers['cache-control'], 'no-store');
    for (const headers of [sessionHeaders, { ...sessionHeaders, Origin: publicOrigin }, { ...sessionHeaders, Origin: publicOrigin, 'X-CSRF-Token': 'wrong' }]) {
      assert.equal((await app.request(route('api/tasks'), 'POST', { title: 'Must not be created' }, headers)).status, 403);
    }
    const writeHeaders = { ...sessionHeaders, Origin: publicOrigin, 'X-CSRF-Token': signed.body.csrfToken! };
    const created = await app.request<Task>(route('api/tasks'), 'POST', { title: 'Authenticated hosted task' }, { ...writeHeaders, 'Idempotency-Key': randomUUID() });
    assert.equal(created.status, 201); assert.equal(created.body.title, 'Authenticated hosted task');
    const readToken = app.auth.createToken(app.account.id, { name: 'Hosted read fixture', scopes: ['read'] });
    const writerToken = app.auth.createToken(app.account.id, { name: 'Hosted write fixture', scopes: ['read', 'write'] });
    const readHeaders = { Authorization: `Bearer ${readToken.token}` }, tokenHeaders = { Authorization: `Bearer ${writerToken.token}` };
    assert.equal((await app.request(route('api/state'), 'GET', undefined, readHeaders)).status, 200);
    assert.equal((await app.request(route('api/tasks'), 'POST', { title: 'Denied scoped write' }, readHeaders)).status, 403);
    assert.equal((await app.request(route('api/tasks'), 'POST', { title: 'Explicit token write' }, { ...tokenHeaders, 'Idempotency-Key': randomUUID() })).status, 201);

    const bytes = Buffer.from('Exact private hosted download.\r\n');
    const uploaded = await app.request<FileRecord>(route('api/files'), 'POST', { name: 'private.txt', dataBase64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }, { ...writeHeaders, 'Idempotency-Key': randomUUID() });
    assert.equal(uploaded.status, 201);
    assert.equal((await app.request(route(`api/files/${uploaded.body.id}/data`))).status, 401);
    const download = await app.request(route(`api/files/${uploaded.body.id}/data`), 'GET', undefined, sessionHeaders);
    assert.equal(download.status, 200); assert.equal(download.text, bytes.toString()); assert.equal(download.headers['cache-control'], 'private, no-store');

    const document = await app.request<WikiDocument>(route('api/documents'), 'POST', { title: 'Hosted Wiki', slug: '/', content: 'Immutable hosted source.' }, { ...tokenHeaders, 'Idempotency-Key': randomUUID() });
    assert.equal(document.status, 201);
    const conduit = await app.request<{ result: { uri: string; content: string }; error_code: string | null }>(route('api/phriction.info'), 'POST', { slug: '/', __conduit__: { token: readToken.token } });
    assert.equal(conduit.status, 200); assert.equal(conduit.body.error_code, null); assert.equal(conduit.body.result.uri, `${publicOrigin}${basePath}w/`); assert.equal(conduit.body.result.content, 'Immutable hosted source.'); assert.equal(conduit.headers['cache-control'], 'no-store');
    const conduitWrite = await app.request<{ result: { uri: string; content: string }; error_code: string | null }>(route('api/phriction.create'), 'POST', { slug: 'token-created/', title: 'Hosted token page', content: 'Exact hosted token source.', __conduit__: { token: writerToken.token } }, { 'Idempotency-Key': randomUUID() });
    assert.equal(conduitWrite.status, 200); assert.equal(conduitWrite.body.error_code, null); assert.equal(conduitWrite.body.result.uri, `${publicOrigin}${basePath}w/token-created/`); assert.equal(conduitWrite.body.result.content, 'Exact hosted token source.');
    const redirect = await app.request(route('w/'));
    assert.equal(redirect.status, 302); assert.equal(redirect.headers.location, `${basePath}#wiki/`); assert.equal(redirect.headers['cache-control'], 'no-store');
    if (basePath !== '/') {
      const mounted = await app.request(basePath.slice(0, -1));
      assert.equal(mounted.status, 308); assert.equal(mounted.headers.location, basePath); assert.equal(mounted.headers['cache-control'], 'no-store');
    }

    const loggedOut = await app.request<SessionState>(route('api/logout'), 'POST', {}, writeHeaders);
    assert.equal(loggedOut.status, 200); assert.equal(loggedOut.body.account, null); assert.equal(loggedOut.headers['cache-control'], 'no-store');
    const cleared = loggedOut.headers['set-cookie']!;
    assert.ok(cleared.some(cookie => cookie.startsWith(`${pair(sessionCookie).split('=')[0]}=;`) && cookie.includes('Max-Age=0; Secure')));
    assert.ok(cleared.every(cookie => cookie.includes('; Secure') && cookie.includes(`; Path=${basePath};`) && !/Domain=/i.test(cookie)));
    assert.equal((await app.request(route('api/state'), 'GET', undefined, sessionHeaders)).status, 401);
    assert.equal((await app.request(route('api/state'), 'GET', undefined, readHeaders)).status, 200, 'Signing out a browser does not revoke separately issued tokens.');
  } finally { await app.close(); }
});
