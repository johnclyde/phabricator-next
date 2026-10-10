import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import type { IncomingMessage } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createAuth, type Auth } from '../server/auth.ts';
import type { AuthScope } from '../shared/auth.ts';

const origin = 'http://127.0.0.1:4310';
const password = 'correct horse battery staple';
const req = (headers: Record<string, string | undefined> = {}, method = 'GET') => ({ method, headers: { host: '127.0.0.1:4310', ...headers } }) as IncomingMessage;
const cookiePair = (cookie: string) => cookie.split(';')[0]!;
const status = (expected: number) => (error: unknown) => typeof error === 'object' && error !== null && 'status' in error && error.status === expected;
function database() { const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys = ON'); return db; }
async function initialized(now?: () => number) {
  const db = database(); const provisioner = createAuth({ database: db, mode: 'local', basePath: '/workspace/', provisioning: true, now });
  const account = await provisioner.createAccount({ username: 'alice', displayName: 'Alice Example', password });
  const auth = createAuth({ database: db, mode: 'password', basePath: '/workspace/', now });
  return { db, account, auth, provisioner };
}
async function login(auth: Auth, username = 'alice', value = password, oldCookie?: string) {
  const challenge = auth.session(req());
  const result = await auth.login(req({ origin, cookie: `${cookiePair(challenge.cookie!)}${oldCookie ? `; ${oldCookie}` : ''}`, 'x-csrf-token': challenge.session.csrfToken! }, 'POST'), username, value);
  const headers = { cookie: cookiePair(result.cookie), 'x-session-context': result.session.sessionContext!, 'x-csrf-token': result.session.csrfToken!, origin };
  return { ...result, headers, context: auth.authenticate(req(headers)) };
}

test('authentication persists workspace identity and forbids password-mode downgrade or empty bootstrap', async () => {
  const db = database();
  try {
    assert.throws(() => createAuth({ database: db, mode: 'password', basePath: '/' }), /not initialized/);
    const local = createAuth({ database: db, mode: 'local', basePath: '/' });
    const first = local.authenticate(req());
    assert.equal(first.displayName, 'You'); assert.equal(first.kind, 'local');
    assert.equal(createAuth({ database: db, mode: 'local', basePath: '/' }).workspaceId, local.workspaceId);
    assert.equal(local.session(req()).session.account!.id, first.principalId);
    const account = await local.createAccount({ username: 'Alice', displayName: 'Alice Example', password });
    assert.equal(account.username, 'alice');
    const auth = createAuth({ database: db, mode: 'password', basePath: '/' });
    assert.equal(auth.workspaceId, local.workspaceId);
    assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 3);
    assert.throws(() => local.authenticate(req()), status(401));
    assert.throws(() => createAuth({ database: db, mode: 'local', basePath: '/' }), /requires password authentication/);
    assert.equal(createAuth({ database: db, mode: 'local', basePath: '/', provisioning: true }).listAccounts()[0]!.id, account.id);
    const row = db.prepare('SELECT * FROM auth_accounts').get() as Record<string, string>;
    assert.match(row.password_hash!, /^[a-f0-9]{64}$/); assert.match(row.salt!, /^[a-f0-9]{64}$/);
    assert.equal(row.password_scheme, 'scrypt-v1');
    assert.ok(!JSON.stringify(row).includes(password));
    assert.deepEqual(Object.keys(account).sort(), ['disabled', 'displayName', 'id', 'username']);
  } finally { db.close(); }
});

test('sign-in requires a same-origin one-use challenge and protected reads require the current session context', async () => {
  const { db, auth, account } = await initialized();
  try {
    const challenge = auth.session(req());
    assert.equal(challenge.session.account, null);
    assert.match(challenge.cookie!, /Path=\/workspace\/; HttpOnly; SameSite=Strict/);
    const cookie = cookiePair(challenge.cookie!);
    assert.equal(auth.session(req({ cookie })).session.csrfToken, challenge.session.csrfToken);
    for (const headers of [
      { cookie, origin },
      { cookie, 'x-csrf-token': challenge.session.csrfToken! },
      { cookie, 'x-csrf-token': challenge.session.csrfToken!, origin: 'http://localhost:4310' },
      { cookie, 'x-csrf-token': challenge.session.csrfToken!, origin: 'https://evil.example' },
    ]) await assert.rejects(auth.login(req(headers, 'POST'), 'alice', password), status(403));
    const signed = await auth.login(req({ cookie, origin, 'x-csrf-token': challenge.session.csrfToken! }, 'POST'), 'alice', password);
    assert.equal(signed.session.account!.id, account.id); assert.ok(signed.session.expiresAt);
    assert.match(signed.cookie, /HttpOnly; SameSite=Strict; Max-Age=43200/);
    await assert.rejects(auth.login(req({ cookie, origin, 'x-csrf-token': challenge.session.csrfToken! }, 'POST'), 'alice', password), status(403));
    const sessionCookie = cookiePair(signed.cookie);
    assert.throws(() => auth.authenticate(req({ cookie: sessionCookie })), status(401));
    assert.throws(() => auth.authenticate(req({ cookie: sessionCookie, 'x-session-context': 'another-tab' })), status(401));
    const headers = { cookie: sessionCookie, 'x-session-context': signed.session.sessionContext! };
    const context = auth.authenticate(req(headers));
    assert.equal(context.principalId, account.id); assert.equal(context.displayName, 'Alice Example');
    assert.throws(() => auth.authenticate(req(headers, 'POST'), 'write'), status(403));
    assert.throws(() => auth.authenticate(req({ ...headers, origin }, 'POST'), 'write'), status(403));
    assert.equal(auth.authenticate(req({ ...headers, origin, 'x-csrf-token': signed.session.csrfToken! }, 'POST'), 'write').principalId, account.id);
    const stored = db.prepare('SELECT secret_hash FROM auth_sessions').get() as { secret_hash: string };
    assert.match(stored.secret_hash, /^[a-f0-9]{64}$/); assert.ok(!sessionCookie.includes(stored.secret_hash));
    const siblingMount = createAuth({ database: db, mode: 'password', basePath: '/other/' });
    assert.throws(() => siblingMount.authenticate(req(headers)), status(401));
  } finally { db.close(); }
});

test('session rotation, logout, password reset, expiry and account disable revoke existing authority', async () => {
  let now = Date.now(); const { db, auth, account } = await initialized(() => now);
  try {
    const first = await login(auth);
    const second = await login(auth, 'alice', password, first.headers.cookie);
    assert.notEqual(first.context.credentialId, second.context.credentialId);
    assert.throws(() => auth.revalidate(first.context), status(401));
    const cleared = auth.logout(second.context);
    assert.match(cleared.cookie, /Max-Age=0/); assert.throws(() => auth.revalidate(second.context), status(401));
    const expiring = await login(auth);
    now += 12 * 60 * 60 * 1000 + 1;
    assert.throws(() => auth.revalidate(expiring.context), status(401));
    assert.equal(auth.session(req(expiring.headers)).session.account, null);
    const reset = await login(auth);
    const token = auth.createToken(account.id, { name: 'Old password token', scopes: ['read'] });
    await auth.resetPassword(account.id, 'a replacement password phrase');
    assert.throws(() => auth.revalidate(reset.context), status(401));
    assert.throws(() => auth.authenticate(req({ authorization: `Bearer ${token.token}` })), status(401));
    await assert.rejects(login(auth), status(401));
    const current = await login(auth, 'alice', 'a replacement password phrase');
    auth.setAccountDisabled(account.id, true);
    assert.throws(() => auth.revalidate(current.context), status(401));
    assert.equal(auth.session(req(current.headers)).session.account, null);
    await assert.rejects(login(auth, 'alice', 'a replacement password phrase'), status(401));
    auth.setAccountDisabled(account.id, false);
    assert.throws(() => auth.revalidate(current.context), status(401));
  } finally { db.close(); }
});

test('login rotates the challenge token without changing the shared browser cookie across logout bootstraps', async () => {
  const { db, auth } = await initialized();
  try {
    const challenge = auth.session(req());
    const challengeCookie = cookiePair(challenge.cookie!);
    const first = await auth.login(req({ cookie: challengeCookie, origin, 'x-csrf-token': challenge.session.csrfToken! }, 'POST'), 'alice', password);
    const headers = { cookie: `${challengeCookie}; ${cookiePair(first.cookie)}`, origin, 'x-session-context': first.session.sessionContext!, 'x-csrf-token': first.session.csrfToken! };
    auth.logout(auth.authenticate(req(headers, 'POST')));
    const logoutResponse = auth.session(req(headers));
    const otherTabResponse = auth.session(req(headers));
    assert.equal(logoutResponse.cookie, undefined);
    assert.equal(otherTabResponse.cookie, undefined);
    assert.equal(logoutResponse.session.csrfToken, otherTabResponse.session.csrfToken);
    assert.notEqual(logoutResponse.session.csrfToken, challenge.session.csrfToken);
    await assert.rejects(auth.login(req({ cookie: challengeCookie, origin, 'x-csrf-token': challenge.session.csrfToken! }, 'POST'), 'alice', password), status(403));
    const next = await auth.login(req({ cookie: challengeCookie, origin, 'x-csrf-token': otherTabResponse.session.csrfToken! }, 'POST'), 'alice', password);
    assert.equal(next.session.account!.username, 'alice');
    assert.notEqual(next.session.sessionContext, first.session.sessionContext);
  } finally { db.close(); }
});

test('access tokens have explicit independent scopes, expiry, revocation and account binding', async () => {
  let now = Date.now(); const { db, auth, account } = await initialized(() => now);
  try {
    const read = auth.createToken(account.id, { name: 'Reader', scopes: ['read'], expiresInDays: 1 });
    const request = req({ authorization: `Bearer ${read.token}` });
    const context = auth.authenticate(request);
    assert.equal(context.kind, 'token'); assert.equal(context.principalId, account.id);
    for (const scope of ['write', 'review:local', 'review:hosted'] as const) assert.throws(() => auth.authenticate(request, scope), status(403));
    const worker = auth.createToken(account.id, { name: 'Local review worker', scopes: ['read', 'write', 'review:local'] });
    assert.equal(auth.authenticate(req({ authorization: `Bearer ${worker.token}` }, 'POST'), 'review:local').principalId, account.id);
    assert.throws(() => auth.authenticate(req({ authorization: `Bearer ${worker.token}` }, 'POST'), 'review:hosted'), status(403));
    const signed = await login(auth);
    assert.throws(() => auth.authenticate(req({ ...signed.headers, authorization: `Bearer ${read.token}` })), status(401));
    const stored = db.prepare('SELECT secret_hash FROM auth_tokens WHERE id = ?').get(read.record.id) as { secret_hash: string };
    assert.match(stored.secret_hash, /^[a-f0-9]{64}$/); assert.ok(!JSON.stringify(auth.listTokens(account.id)).includes(read.token));
    auth.revokeToken(account.id, worker.record.id);
    assert.throws(() => auth.authenticate(req({ authorization: `Bearer ${worker.token}` })), status(401));
    assert.equal(auth.listTokens(account.id).find(item => item.id === worker.record.id)!.revoked, true);
    now += 86_400_001;
    assert.throws(() => auth.revalidate(context), status(401));
    for (const days of [0, 91, 1.5]) assert.throws(() => auth.createToken(account.id, { name: 'Invalid expiry', scopes: ['read'], expiresInDays: days }), status(400));
    for (const scopes of [[], ['read', 'read'], ['admin']]) assert.throws(() => auth.createToken(account.id, { name: 'Invalid scope', scopes: scopes as AuthScope[] }), status(400));
    auth.setAccountDisabled(account.id, true);
    assert.throws(() => auth.createToken(account.id, { name: 'Disabled', scopes: ['read'] }), status(404));
  } finally { db.close(); }
});

test('login throttling persists between auth instances and returns generic failures without credential data', async () => {
  let now = Date.now(); const { db, auth } = await initialized(() => now);
  try {
    const challenge = auth.session(req());
    const headers = { cookie: cookiePair(challenge.cookie!), origin, 'x-csrf-token': challenge.session.csrfToken! };
    const rejectedPassword = 'this secret must never appear in errors';
    for (let count = 0; count < 10; count += 1) {
      await assert.rejects(auth.login(req(headers, 'POST'), 'unknown-account', rejectedPassword), error => status(401)(error) && !(error as Error).message.includes(rejectedPassword));
    }
    const reopened = createAuth({ database: db, mode: 'password', basePath: '/workspace/', now: () => now });
    await assert.rejects(reopened.login(req(headers, 'POST'), 'unknown-account', rejectedPassword), status(429));
    now += 15 * 60 * 1000 + 1;
    const fresh = reopened.session(req());
    await assert.rejects(reopened.login(req({ cookie: cookiePair(fresh.cookie!), origin, 'x-csrf-token': fresh.session.csrfToken! }, 'POST'), 'unknown-account', rejectedPassword), status(401));
    await assert.rejects(auth.createAccount({ username: 'invalid name', displayName: 'Bad', password }), status(400));
    await assert.rejects(auth.createAccount({ username: 'short', displayName: 'Short', password: 'short' }), status(400));
  } finally { db.close(); }
});

test('account disable and password changes during the async KDF cannot complete a stale sign-in', async () => {
  const { db, auth, account } = await initialized();
  try {
    const pending = login(auth);
    auth.setAccountDisabled(account.id, true);
    await assert.rejects(pending, status(401));
    auth.setAccountDisabled(account.id, false);
    const challenge = auth.session(req());
    const headers = { origin, cookie: cookiePair(challenge.cookie!), 'x-csrf-token': challenge.session.csrfToken! };
    const one = auth.login(req(headers, 'POST'), 'alice', password);
    const two = auth.login(req(headers, 'POST'), 'alice', password);
    await assert.rejects(auth.login(req(headers, 'POST'), 'alice', password), status(429));
    const results = await Promise.allSettled([one, two]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
    assert.equal((db.prepare('SELECT count(*) AS count FROM auth_sessions').get() as { count: number }).count, 1);
    const stalePassword = login(auth);
    db.prepare('UPDATE auth_accounts SET password_hash = ? WHERE id = ?').run('00'.repeat(32), account.id);
    await assert.rejects(stalePassword, status(401));
    db.prepare("UPDATE auth_accounts SET password_scheme = 'unknown-future-scheme' WHERE id = ?").run(account.id);
    await assert.rejects(login(auth), status(401));
  } finally { db.close(); }
});

test('operator account commands take passwords through stdin and expose token secrets only on creation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'phab-account-cli-'));
  const script = fileURLToPath(new URL('../scripts/accounts.ts', import.meta.url));
  const run = (args: string[], input = '') => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), script, ...args], { env: { ...process.env, DATABASE_PATH: join(directory, 'workspace.sqlite'), APP_BASE_PATH: '/workspace/' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (value: Buffer) => { stdout += value.toString(); });
    child.stderr.on('data', (value: Buffer) => { stderr += value.toString(); });
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr })); child.stdin.end(input);
  });
  try {
    const created = await run(['create', 'alice', '--name', 'Alice Example', '--password-stdin'], `${password}\n`);
    assert.equal(created.code, 0, created.stderr); assert.ok(!`${created.stdout}${created.stderr}`.includes(password));
    const listed = await run(['list']); assert.equal(listed.code, 0, listed.stderr);
    assert.equal(JSON.parse(listed.stdout)[0].username, 'alice'); assert.ok(!listed.stdout.includes('password_hash'));
    const token = await run(['token', 'alice', '--name', 'Test reader', '--scopes', 'read', '--days', '1']);
    assert.equal(token.code, 0, token.stderr); assert.match(token.stdout.trim(), /^phab_[A-Za-z0-9_-]{43}$/);
    const tokens = await run(['tokens', 'alice']); assert.equal(tokens.code, 0, tokens.stderr);
    assert.ok(!tokens.stdout.includes(token.stdout.trim())); assert.deepEqual(JSON.parse(tokens.stdout)[0].scopes, ['read']);
    const reset = await run(['reset', 'alice', '--password-stdin'], 'replacement password for this account\n');
    assert.equal(reset.code, 0, reset.stderr);
    assert.equal(JSON.parse((await run(['tokens', 'alice'])).stdout)[0].revoked, true);
    assert.equal((await run(['create', 'bob', '--password-stdin'], 'tiny\n')).code, 1);
    assert.equal((await run(['disable', 'alice'])).code, 0);
    assert.equal(JSON.parse((await run(['list'])).stdout)[0].disabled, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
