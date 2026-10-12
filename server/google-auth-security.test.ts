import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import type { IncomingMessage } from 'node:http';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { createAuth, type Auth } from './auth.ts';
import { createGoogleTokenVerifier, googleAuthConfiguration, type GoogleIdentity, type GoogleTokenVerifier } from './google-auth.ts';

const NOW = Date.parse('2026-10-12T12:00:00Z'), seconds = NOW / 1000;
const origin = 'https://reviews.example.test', password = 'Security test password phrase';
const config = googleAuthConfiguration({ projectId: 'security-fixture', apiKey: 'A'.repeat(39), authDomain: 'security-fixture.firebaseapp.com', appId: '1:123456789:web:123456789abcdef0', accounts: { 'approved-firebase-uid': 'alice' } });
const keys = await generateKeyPair('RS256', { extractable: true });
const publicKey = { ...await exportJWK(keys.publicKey), kid: 'fixture-signing-key', alg: 'RS256', use: 'sig' };
const keySet = createLocalJWKSet({ keys: [publicKey] });
const claims = (): JWTPayload => ({ iss: `https://securetoken.google.com/${config.projectId}`, aud: config.projectId, sub: 'approved-firebase-uid', user_id: 'approved-firebase-uid', iat: seconds, exp: seconds + 3600, auth_time: seconds - 30, email: 'alice@example.test', email_verified: true, firebase: { sign_in_provider: 'google.com' } });
const signed = (payload: JWTPayload = claims(), kid = publicKey.kid) => new SignJWT(payload).setProtectedHeader({ alg: 'RS256', kid }).sign(keys.privateKey);
const request = (headers: Record<string, string | undefined> = {}) => ({ method: 'POST', headers: { host: 'reviews.example.test', origin, ...headers } }) as IncomingMessage;
const status = (expected: number) => (error: unknown) => Boolean(error && typeof error === 'object' && 'status' in error && error.status === expected);
const identity = (uid = 'approved-firebase-uid'): GoogleIdentity => ({ uid, issuedAt: seconds, authenticatedAt: seconds - 30, expiresAt: seconds + 3600 });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(finish => { resolve = finish; }); return { promise, resolve }; }
function anonymous(auth: Auth) {
  const result = auth.session(request());
  return request({ cookie: result.cookie!.split(';')[0], 'x-csrf-token': result.session.csrfToken! });
}
async function fixture(verify: GoogleTokenVerifier = createGoogleTokenVerifier(config, { keySet, now: () => NOW }), now = () => NOW) {
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON');
  const provision = createAuth({ database: db, mode: 'local', basePath: '/review/', provisioning: true, now });
  const alice = await provision.createAccount({ username: 'alice', displayName: 'Alice', password });
  const auth = createAuth({ database: db, mode: 'password', basePath: '/review/', publicOrigin: origin, googleAuth: config, googleTokenVerifier: verify, now });
  const sessions = () => (db.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get() as { n: number }).n;
  return { db, auth, alice, sessions };
}

test('Firebase Google verifier accepts a signed exact-project identity but strips token/profile contents', async () => {
  const verify = createGoogleTokenVerifier(config, { keySet, now: () => NOW });
  assert.deepEqual(await verify(await signed()), identity());
});

test('signed tokens cannot change project, provider, tenant, subject, or authentication chronology', async () => {
  const verify = createGoogleTokenVerifier(config, { keySet, now: () => NOW });
  const invalid: Record<string, Partial<JWTPayload>> = {
    'different project': { aud: 'another-project' },
    'audience array': { aud: [config.projectId, 'another-project'] },
    'Google OAuth token is not Firebase': { iss: 'https://accounts.google.com' },
    'wrong Firebase issuer': { iss: 'https://securetoken.google.com/another-project' },
    'missing subject': { sub: undefined },
    'empty subject': { sub: '' },
    'oversized Firebase UID': { sub: 'a'.repeat(129), user_id: 'a'.repeat(129) },
    'mismatched secondary identity': { user_id: 'another-user' },
    'expired token': { exp: seconds },
    'future issued token': { iat: seconds + 1 },
    'future authentication': { auth_time: seconds + 1 },
    'authentication after issuance': { iat: seconds - 60 },
    'old authentication with a fresh refresh token': { auth_time: seconds - 301 },
    'missing authentication time': { auth_time: undefined },
    'string authentication time': { auth_time: String(seconds) },
    'fractional authentication time': { auth_time: seconds - 0.5 },
    'unverified email': { email_verified: false },
    'string verified email': { email_verified: 'true' },
    'password provider': { firebase: { sign_in_provider: 'password' } },
    'anonymous provider': { firebase: { sign_in_provider: 'anonymous' } },
    'custom provider': { firebase: { sign_in_provider: 'custom' } },
    'missing provider': { firebase: {} },
    'provider tenant': { firebase: { sign_in_provider: 'google.com', tenant: 'another-tenant' } },
    'empty provider tenant': { firebase: { sign_in_provider: 'google.com', tenant: '' } },
    'top-level tenant': { tenant: 'another-tenant' },
  };
  for (const [label, changed] of Object.entries(invalid)) await assert.rejects(verify(await signed({ ...claims(), ...changed })), status(401), label);
  const boundary = { ...claims(), auth_time: seconds - 300 };
  assert.equal((await verify(await signed(boundary))).authenticatedAt, seconds - 300);
});

test('the verifier rejects forged signatures, unknown keys, HMAC confusion, unsigned and oversized tokens', async () => {
  const verify = createGoogleTokenVerifier(config, { keySet, now: () => NOW });
  const attacker = await generateKeyPair('RS256');
  const forged = await new SignJWT(claims()).setProtectedHeader({ alg: 'RS256', kid: publicKey.kid }).sign(attacker.privateKey);
  const hmac = await new SignJWT(claims()).setProtectedHeader({ alg: 'HS256', kid: publicKey.kid }).sign(new TextEncoder().encode(JSON.stringify(publicKey)));
  for (const token of [forged, hmac, await signed(claims(), 'unknown-key'), `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims())).toString('base64url')}.`, 'a'.repeat(16385), 'not.a.token']) await assert.rejects(verify(token), status(401));
});

test('Google login checks exact origin, challenge, mount and CSRF before attempting token verification', async () => {
  let calls = 0; const f = await fixture(async () => { calls++; return identity(); });
  try {
    const original = anonymous(f.auth), headers = original.headers as Record<string, string>;
    for (const changed of [{ cookie: undefined }, { 'x-csrf-token': undefined }, { 'x-csrf-token': 'wrong' }, { origin: 'https://elsewhere.example.test' }, { origin: undefined }, { cookie: `${headers.cookie}; ${headers.cookie}` }]) await assert.rejects(f.auth.loginGoogle(request({ ...headers, ...changed }), 'ignored-before-verification'), error => status(403)(error) || status(401)(error));
    const sibling = createAuth({ database: f.db, mode: 'password', basePath: '/other/', publicOrigin: origin, googleAuth: config, googleTokenVerifier: async () => { calls++; return identity(); }, now: () => NOW });
    await assert.rejects(sibling.loginGoogle(original, 'ignored-before-verification'), status(403));
    assert.equal(calls, 0); assert.equal(f.sessions(), 0);
  } finally { f.db.close(); }
});

test('same-email unmapped identities cannot create or inherit a workspace account, including prototype property names', async () => {
  const f = await fixture();
  try {
    const accounts = f.auth.listAccounts();
    for (const uid of ['unmapped-firebase-uid', 'constructor', '__proto__', 'toString']) {
      const token = await signed({ ...claims(), sub: uid, user_id: uid });
      await assert.rejects(f.auth.loginGoogle(anonymous(f.auth), token), status(401), uid);
    }
    assert.deepEqual(f.auth.listAccounts(), accounts); assert.equal(f.sessions(), 0);
  } finally { f.db.close(); }
});

test('a mapped account disabled during asynchronous token verification receives no session', async () => {
  const began = deferred<void>(), answer = deferred<GoogleIdentity>();
  const f = await fixture(async () => { began.resolve(); return answer.promise; });
  try {
    const pending = f.auth.loginGoogle(anonymous(f.auth), 'held-verification');
    const rejected = assert.rejects(pending, status(401));
    await began.promise; f.auth.setAccountDisabled(f.alice.id, true); answer.resolve(identity());
    await rejected; assert.equal(f.sessions(), 0);
  } finally { f.db.close(); }
});

test('a password reset during Google verification retires the pending credential snapshot', async () => {
  const began = deferred<void>(), answer = deferred<GoogleIdentity>();
  const f = await fixture(async () => { began.resolve(); return answer.promise; });
  try {
    const pending = f.auth.loginGoogle(anonymous(f.auth), 'held-before-password-reset');
    const rejected = assert.rejects(pending, status(401));
    await began.promise;
    await f.auth.resetPassword(f.alice.id, 'Reset during verification password phrase');
    answer.resolve(identity()); await rejected;
    assert.equal(f.sessions(), 0);
    const recovery = await f.auth.login(anonymous(f.auth), 'alice', 'Reset during verification password phrase');
    assert.equal(recovery.session.account!.id, f.alice.id);
  } finally { f.db.close(); }
});

test('token expiration during verification is rejected even while authentication remains recent', async () => {
  let now = NOW; const began = deferred<void>(), answer = deferred<GoogleIdentity>();
  const f = await fixture(async () => { began.resolve(); return answer.promise; }, () => now);
  try {
    const pending = f.auth.loginGoogle(anonymous(f.auth), 'held-near-expiration');
    const rejected = assert.rejects(pending, status(401));
    await began.promise; now += 2_000;
    answer.resolve({ ...identity(), expiresAt: seconds + 1 }); await rejected;
    assert.equal(f.sessions(), 0);
  } finally { f.db.close(); }
});

test('Google login does not mix bearer credentials and bounds concurrent verifier work', async () => {
  const answer = deferred<GoogleIdentity>(); let calls = 0;
  const f = await fixture(async () => { calls++; return answer.promise; });
  try {
    const req = anonymous(f.auth);
    await assert.rejects(f.auth.loginGoogle(request({ ...req.headers as Record<string, string>, authorization: 'Bearer ignored' }), 'not-sent-to-provider'), status(400));
    assert.equal(calls, 0);
    const pending = [f.auth.loginGoogle(req, 'one'), f.auth.loginGoogle(req, 'two')];
    const outcomes = Promise.allSettled(pending);
    await assert.rejects(f.auth.loginGoogle(anonymous(f.auth), 'over-concurrency-bound'), status(429));
    assert.equal(calls, 2);
    answer.resolve(identity()); await outcomes;
    assert.equal(f.sessions(), 1);
  } finally { f.db.close(); }
});

test('a password login in another tab retires the pending Google challenge instead of switching that session', async () => {
  const began = deferred<void>(), answer = deferred<GoogleIdentity>();
  const f = await fixture(async () => { began.resolve(); return answer.promise; });
  try {
    const req = anonymous(f.auth), pending = f.auth.loginGoogle(req, 'held-verification');
    const rejected = assert.rejects(pending, error => status(401)(error) || status(403)(error));
    await began.promise; const passwordSession = await f.auth.login(req, 'alice', password);
    answer.resolve(identity()); await rejected;
    assert.equal(f.sessions(), 1);
    assert.equal(f.auth.session(request({ cookie: passwordSession.cookie.split(';')[0] })).session.sessionContext, passwordSession.session.sessionContext);
  } finally { f.db.close(); }
});

test('concurrent Google attempts can consume a browser challenge only once', async () => {
  const bothStarted = deferred<void>(), answer = deferred<GoogleIdentity>(); let calls = 0;
  const f = await fixture(async () => { if (++calls === 2) bothStarted.resolve(); return answer.promise; });
  try {
    const req = anonymous(f.auth), outcomes = Promise.allSettled([f.auth.loginGoogle(req, 'first'), f.auth.loginGoogle(req, 'second')]);
    await bothStarted.promise; answer.resolve(identity());
    const result = await outcomes;
    assert.equal(result.filter(row => row.status === 'fulfilled').length, 1);
    assert.equal(result.filter(row => row.status === 'rejected').length, 1);
    assert.equal(f.sessions(), 1);
  } finally { f.db.close(); }
});

test('freshness is checked after awaited verification and no provider error leaks credentials', async () => {
  let now = NOW; const began = deferred<void>(), answer = deferred<GoogleIdentity>();
  const f = await fixture(async () => { began.resolve(); return answer.promise; }, () => now);
  try {
    const pending = f.auth.loginGoogle(anonymous(f.auth), 'private-id-token');
    const rejected = assert.rejects(pending, status(401));
    await began.promise; now += 301_000; answer.resolve(identity()); await rejected;
    assert.equal(f.sessions(), 0);
  } finally { f.db.close(); }
  const broken = await fixture(async () => { throw new Error('provider-debug SECRET_TOKEN account=alice uid=approved-firebase-uid'); });
  try {
    await assert.rejects(broken.auth.loginGoogle(anonymous(broken.auth), 'SECRET_TOKEN'), error => {
      assert.ok(status(401)(error)); assert.ok(error instanceof Error); assert.doesNotMatch(error.message, /SECRET_TOKEN|account=|approved-firebase-uid|provider-debug/); return true;
    });
    assert.equal(broken.sessions(), 0);
  } finally { broken.db.close(); }
});

test('Google sessions retain normal workspace context, CSRF, disable and password-recovery boundaries', async () => {
  const f = await fixture();
  try {
    const result = await f.auth.loginGoogle(anonymous(f.auth), await signed());
    assert.equal(result.session.account!.id, f.alice.id); assert.match(result.cookie, /Path=\/review\/; HttpOnly; SameSite=Strict/); assert.match(result.cookie, /; Secure$/);
    const cookie = result.cookie.split(';')[0]!, context = result.session.sessionContext!;
    assert.throws(() => f.auth.authenticate(request({ cookie })), status(401));
    assert.throws(() => f.auth.authenticate(request({ cookie, 'x-session-context': context }), 'write'), status(403));
    const grant = f.auth.authenticate(request({ cookie, 'x-session-context': context, 'x-csrf-token': context }), 'write');
    const challenge = anonymous(f.auth);
    await assert.rejects(f.auth.loginGoogle(request({ ...challenge.headers as Record<string, string>, cookie: `${cookie}; ${challenge.headers.cookie}` }), await signed()), status(409));
    await f.auth.resetPassword(f.alice.id, 'Replacement recovery password phrase');
    assert.throws(() => f.auth.revalidate(grant), status(401)); assert.equal(f.sessions(), 0);
    const passwordSession = await f.auth.login(anonymous(f.auth), 'alice', 'Replacement recovery password phrase');
    assert.equal(passwordSession.session.account!.id, f.alice.id);
  } finally { f.db.close(); }
});
