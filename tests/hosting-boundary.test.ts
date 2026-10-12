import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { request as requestHttp, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/app';
import { createAuth } from '../server/auth';
import { createStore } from '../server/store';
import { assertHostingRequest, hostingConfiguration } from '../server/hosting';

const origin = 'https://workspace.example';
const host = 'workspace.example';
const denied = (error: unknown) => Boolean(error && typeof error === 'object' && 'status' in error && error.status === 403);
function request(overrides: { headers?: IncomingHttpHeaders; rawHeaders?: string[]; method?: string; url?: string; remoteAddress?: string } = {}): IncomingMessage {
  const headers: IncomingHttpHeaders = { host, ...overrides.headers };
  const rawHeaders = overrides.rawHeaders ?? Object.entries(headers).flatMap(([name, value]) => value === undefined ? [] : (Array.isArray(value) ? value : [value]).flatMap(item => [name, item]));
  return { headers, rawHeaders, method: overrides.method ?? 'GET', url: overrides.url ?? '/', socket: { remoteAddress: overrides.remoteAddress ?? '127.0.0.1', localPort: 4310 } } as IncomingMessage;
}

test('hosted configuration accepts only an explicit canonical HTTPS origin and password mode', () => {
  assert.equal(hostingConfiguration(undefined, 'local'), undefined);
  assert.equal(hostingConfiguration(undefined, 'password'), undefined);
  assert.deepEqual(hostingConfiguration(origin, 'password'), { origin, host });
  assert.deepEqual(hostingConfiguration('https://workspace.example:8443', 'password'), { origin: 'https://workspace.example:8443', host: 'workspace.example:8443' });
  assert.throws(() => hostingConfiguration(origin, 'local'));
  for (const invalid of [
    '', ' ', 'http://workspace.example', 'ftp://workspace.example', 'workspace.example', '//workspace.example',
    'https://workspace.example/', 'https://workspace.example/mount', 'https://workspace.example?x=1', 'https://workspace.example?', 'https://workspace.example#',
    'https://user:pass@workspace.example', 'https://WORKSPACE.example', 'HTTPS://workspace.example', 'https://workspace.example:443',
    ' https://workspace.example', 'https://workspace.example\n', 'https://workspace.example\\elsewhere', 'https://%77orkspace.example',
  ]) assert.throws(() => hostingConfiguration(invalid, 'password'), invalid);
});

test('invalid hosting fails before creating a database or changing direct Auth state', () => {
  const directory = mkdtempSync(join(tmpdir(), 'phab-hosting-config-'));
  try {
    for (const options of [{ publicOrigin: origin, authMode: 'local' as const }, { publicOrigin: origin }, { publicOrigin: 'http://workspace.example', authMode: 'password' as const }]) {
      const path = join(directory, 'must-not-exist.sqlite');
      assert.throws(() => createApp({ databasePath: path, seed: false, ...options }));
      assert.equal(existsSync(path), false, 'rejected configuration does not initialize or migrate a workspace');
    }
    for (const options of [{ publicOrigin: origin, mode: 'local' as const }, { publicOrigin: 'http://workspace.example', mode: 'password' as const }]) {
      const database = new DatabaseSync(':memory:');
      try {
        assert.throws(() => createAuth({ database, basePath: '/', ...options }));
        assert.equal(database.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get()!.n, 0);
      } finally { database.close(); }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('public request authority comes only from fixed Host and Origin, never forwarded headers or peer claims', () => {
  const hosting = hostingConfiguration(origin, 'password')!;
  for (const remoteAddress of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.doesNotThrow(() => assertHostingRequest(request({ remoteAddress }), 4310, hosting));
  assert.doesNotThrow(() => assertHostingRequest(request({ headers: { origin } }), 4310, hosting));
  assert.doesNotThrow(() => assertHostingRequest(request({ headers: { forwarded: 'for=attacker;proto=http;host=evil.example', 'x-forwarded-proto': 'http', 'x-forwarded-host': 'evil.example', 'x-forwarded-for': '198.51.100.7' } }), 4310, hosting));
  for (const remoteAddress of ['198.51.100.7', '192.168.1.1', '127.0.0.2', '::ffff:198.51.100.7']) assert.throws(() => assertHostingRequest(request({ remoteAddress, headers: { 'x-forwarded-for': '127.0.0.1' } }), 4310, hosting), denied);
  for (const badHost of [undefined, '', 'localhost:4310', '127.0.0.1:4310', 'workspace.example:443', 'workspace.example.evil.test', 'WORKSPACE.example']) assert.throws(() => assertHostingRequest(request({ headers: { host: badHost, 'x-forwarded-host': host, forwarded: `host=${host};proto=https` } }), 4310, hosting), denied);
  assert.throws(() => assertHostingRequest(request({ rawHeaders: ['Host', host, 'hOsT', host] }), 4310, hosting), denied);
  for (const badOrigin of ['null', '', 'http://workspace.example', 'https://workspace.example:443', 'https://other.example', 'http://localhost:5173', `${origin}/`]) assert.throws(() => assertHostingRequest(request({ headers: { origin: badOrigin, 'x-forwarded-proto': 'https', 'x-forwarded-host': host } }), 4310, hosting), denied);
});

test('hosted external entry navigation is narrowly allowed without relaxing API or local-mode gates', () => {
  const hosting = hostingConfiguration(origin, 'password')!;
  const navigation = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
  for (const base of ['/', '/workspace/']) {
    const allowed = [base, `${base}index.html`, ...(base === '/' ? [] : [base.slice(0, -1)])];
    for (const url of allowed) for (const method of ['GET', 'HEAD']) assert.doesNotThrow(() => assertHostingRequest(request({ headers: navigation, method, url }), 4310, hosting, base));
    for (const url of [`${base}api/session`, `${base}api/health`, `${base}w/research/`, `${base}assets/app.js`, `${base}%69ndex.html`, '/outside']) assert.throws(() => assertHostingRequest(request({ headers: navigation, url }), 4310, hosting, base), denied);
    for (const headers of [{ ...navigation, 'sec-fetch-mode': undefined }, { ...navigation, 'sec-fetch-mode': 'cors' }, { ...navigation, 'sec-fetch-dest': 'iframe' }, { ...navigation, 'sec-fetch-dest': undefined }]) assert.throws(() => assertHostingRequest(request({ headers, url: base }), 4310, hosting, base), denied);
    assert.throws(() => assertHostingRequest(request({ headers: navigation, method: 'POST', url: base }), 4310, hosting, base), denied);
    assert.throws(() => assertHostingRequest(request({ headers: { ...navigation, origin: 'https://attacker.example' }, url: base }), 4310, hosting, base), denied);
  }
  assert.throws(() => assertHostingRequest(request({ headers: { ...navigation, host: '127.0.0.1:4310' } }), 4310), denied);
  assert.doesNotThrow(() => assertHostingRequest(request({ headers: { host: '127.0.0.1:4310', origin: 'http://127.0.0.1:5173' } }), 4310));
});

test('real HTTP rejects duplicate or hostile authority before public, redirect and API routes', async () => {
  const store = createStore({ path: ':memory:' });
  const provisioner = createAuth({ database: store.database, mode: 'local', basePath: '/workspace/', provisioning: true });
  await provisioner.createAccount({ username: 'reader', displayName: 'Reader', password: 'A test-only hosted transport password' });
  const app = createApp({ store, seed: false, basePath: '/workspace/', authMode: 'password', publicOrigin: origin });
  const raw = (path: string, headers: string[], method = 'GET') => new Promise<number>((resolve, reject) => {
    const req = requestHttp({ hostname: '127.0.0.1', port: (app.server.address() as AddressInfo).port, method, path, setHost: false, headers: [...headers, 'Connection', 'close'] }, response => { response.resume(); response.on('end', () => resolve(response.statusCode!)); });
    req.on('error', reject); req.end();
  });
  try {
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    assert.equal(await raw('/workspace/api/health', ['Host', host]), 200);
    assert.equal(await raw('/workspace/api/state', ['Host', host]), 401);
    for (const path of ['/workspace', '/workspace/', '/workspace/w/research/', '/workspace/api/health', '/workspace/api/session', '/workspace/api/state', '/workspace/api/phriction.info']) {
      assert.equal(await raw(path, ['Host', host, 'Host', 'evil.example']), 403, path);
      assert.equal(await raw(path, ['Host', 'localhost:4310', 'X-Forwarded-Host', host, 'X-Forwarded-Proto', 'https']), 403, path);
      assert.equal(await raw(path, ['Host', host, 'Origin', 'https://attacker.example']), 403, path);
    }
    assert.equal(await raw('/workspace/api/session', ['Host', host, 'Origin', origin, 'Origin', 'https://attacker.example']), 403);
    assert.equal(await raw('/workspace/api/health', ['Host', host, 'Origin', 'null'], 'OPTIONS'), 403);
    assert.equal(store.database.prepare('SELECT count(*) AS n FROM auth_challenges').get()!.n, 0, 'rejected requests never issue sign-in challenges');
  } finally { await app.close(); store.close(); }
});
