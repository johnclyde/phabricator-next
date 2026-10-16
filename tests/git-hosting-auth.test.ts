import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createAuth } from '../server/auth.ts';
import { createApp } from '../server/app.ts';
import { Store } from '../server/store.ts';
import type { GitReceiveFacts } from '../shared/git-automation.ts';
import type { HeraldRuleInput } from '../shared/herald.ts';

const password = 'Git hosting authentication fixture password';
const status = (expected: number) => (error: unknown) => typeof error === 'object' && error !== null && 'status' in error && error.status === expected;
function request(authorization?: string, cookie?: string, duplicate?: string): IncomingMessage {
  return {
    method: 'POST', headers: { ...(authorization === undefined ? {} : { authorization }), ...(cookie === undefined ? {} : { cookie }) },
    rawHeaders: [...(authorization === undefined ? [] : ['Authorization', authorization]), ...(cookie === undefined ? [] : ['Cookie', cookie]), ...(duplicate === undefined ? [] : ['AUTHORIZATION', duplicate])],
  } as IncomingMessage;
}
const basic = (username: string, token: string) => `Basic ${Buffer.from(`${username}:${token}`).toString('base64')}`;
async function authFixture() {
  const database = new DatabaseSync(':memory:'); let now = Date.now();
  const provisioner = createAuth({ database, mode: 'local', basePath: '/', provisioning: true, now: () => now });
  const alice = await provisioner.createAccount({ username: 'alice', displayName: 'Alice', password });
  const auth = createAuth({ database, mode: 'password', basePath: '/', now: () => now });
  const token = auth.createToken(alice.id, { name: 'Git client', scopes: ['read', 'write'] });
  return { database, alice, auth, token, advance: () => { now += 400 * 24 * 60 * 60 * 1_000; } };
}

test('Git accepts Basic workspace username and token or Bearer, with read and write scopes', async () => {
  const fixture = await authFixture();
  try {
    for (const authorization of [basic('alice', fixture.token.token), `Bearer ${fixture.token.token}`]) {
      for (const scope of ['read', 'write'] as const) {
        const context = fixture.auth.authenticateGit(request(authorization), scope);
        assert.equal(context.kind, 'token'); assert.equal(context.principalId, fixture.alice.id); assert.equal(context.credentialId, fixture.token.record.id);
      }
    }
    const reader = fixture.auth.createToken(fixture.alice.id, { name: 'Clone only', scopes: ['read'] });
    assert.equal(fixture.auth.authenticateGit(request(basic('alice', reader.token))).principalId, fixture.alice.id);
    assert.throws(() => fixture.auth.authenticateGit(request(basic('alice', reader.token)), 'write'), status(403));
    const writer = fixture.auth.createToken(fixture.alice.id, { name: 'Write without source read', scopes: ['write'] });
    assert.throws(() => fixture.auth.authenticateGit(request(basic('alice', writer.token)), 'read'), status(403));
    assert.throws(() => fixture.auth.authenticateGit(request(basic('alice', writer.token)), 'write'), status(403));
  } finally { fixture.database.close(); }
});

test('Git rejects browser cookies, duplicate authorization, passwords and ambiguous Basic credentials', async () => {
  const fixture = await authFixture();
  try {
    const valid = basic('alice', fixture.token.token);
    for (const value of [undefined, '', 'Basic ', 'Basic !!!', `${valid}=`, `${valid} `, valid.replace('Basic ', 'Basic  '), basic('bob', fixture.token.token), basic('Alice', fixture.token.token), basic('alice', password), basic('alice', `${fixture.token.token}:ignored`), basic('alice\n', fixture.token.token), 'Bearer invalid']) {
      assert.throws(() => fixture.auth.authenticateGit(request(value)), status(401));
    }
    for (const cookie of ['', 'unrelated=1', 'phab_session_fake=secret']) assert.throws(() => fixture.auth.authenticateGit(request(valid, cookie)), status(401));
    assert.throws(() => fixture.auth.authenticateGit(request(valid, undefined, valid)), status(401));
    assert.throws(() => fixture.auth.authenticateGit(request(valid, undefined, `Bearer ${fixture.token.token}`)), status(401));
    const challenge = fixture.auth.session({ method: 'GET', headers: {} } as IncomingMessage);
    assert.throws(() => fixture.auth.authenticateGit(request(undefined, challenge.cookie!.split(';')[0])), status(401));
  } finally { fixture.database.close(); }
  const database = new DatabaseSync(':memory:');
  try { const local = createAuth({ database, mode: 'local', basePath: '/' }); assert.throws(() => local.authenticateGit(request()), status(401)); }
  finally { database.close(); }
});

test('Git authentication and captured credentials respect token revocation, scope loss, account disablement and expiry', async () => {
  const fixture = await authFixture();
  try {
    const make = () => fixture.auth.createToken(fixture.alice.id, { name: 'Current credential', scopes: ['read', 'write'] });
    const capture = (token: string) => fixture.auth.authenticateGit(request(basic('alice', token)), 'write');
    const revoked = make(), revokedContext = capture(revoked.token);
    fixture.auth.revokeToken(fixture.alice.id, revoked.record.id);
    assert.throws(() => capture(revoked.token), status(401)); assert.throws(() => fixture.auth.revalidate(revokedContext, 'write'), status(401));
    const scoped = make(), scopedContext = capture(scoped.token);
    fixture.database.prepare('UPDATE auth_tokens SET scopes=? WHERE id=?').run('["read"]', scoped.record.id);
    assert.throws(() => capture(scoped.token), status(403)); assert.throws(() => fixture.auth.revalidate(scopedContext, 'write'), status(403));
    const disabled = make(), disabledContext = capture(disabled.token);
    fixture.auth.setAccountDisabled(fixture.alice.id, true);
    assert.throws(() => capture(disabled.token), status(401)); assert.throws(() => fixture.auth.revalidate(disabledContext, 'read'), status(401));
    fixture.auth.setAccountDisabled(fixture.alice.id, false);
    const expired = make(), expiredContext = capture(expired.token); fixture.advance();
    assert.throws(() => capture(expired.token), status(401)); assert.throws(() => fixture.auth.revalidate(expiredContext, 'read'), status(401));
  } finally { fixture.database.close(); }
});

async function automationFixture() {
  const store = new Store({ path: ':memory:' }), provisioner = createAuth({ database: store.database, mode: 'local', basePath: '/', provisioning: true });
  const alice = await provisioner.createAccount({ username: 'alice', displayName: 'Alice', password }), bob = await provisioner.createAccount({ username: 'bob', displayName: 'Bob', password });
  const app = createApp({ store, seed: false, authMode: 'password', automation: { managers: ['alice'] } });
  store.createRepository({ name: 'Hosted repository', remoteUrl: 'https://example.invalid/repository.git' });
  const token = app.auth.createToken(bob.id, { name: 'Git client', scopes: ['read', 'write'] }), actor = app.auth.authenticateGit(request(basic('bob', token.token)), 'write');
  const facts = (patch: Partial<GitReceiveFacts> = {}): GitReceiveFacts => ({ repositoryId: 'R1', phase: 'pre', requestId: randomUUID(), pusherId: bob.id, objectFormat: 'sha1', inspectionComplete: true, updates: [{ refName: 'refs/heads/main', oldId: 'a'.repeat(40), newId: 'b'.repeat(40), oldCommitId: 'a'.repeat(40), newCommitId: 'b'.repeat(40), forced: false, commits: [] }], ...patch });
  const policy = (patch: Record<string, unknown>) => { const current = app.policies.policy('R1', alice.id); app.policies.setPolicy('R1', { expectedVersion: current.version, spaceId: current.spaceId, ...current.rules, ...patch }, alice.id); };
  return { ...app, alice, bob, token, actor, facts, policy, close: async () => { await app.close(); store.close(); } };
}

test('hosted receive binds transport identity and rechecks current credential, repository and Space authority', async () => {
  const fixture = await automationFixture(); const members = (...principalIds: string[]) => ({ kind: 'principals', principalIds });
  try {
    const facts = fixture.facts(), allowed = fixture.automation.hostedReceive(facts, fixture.actor); assert.equal(allowed.allowed, true);
    assert.throws(() => fixture.automation.hostedReceive(fixture.facts({ pusherId: fixture.alice.id }), fixture.actor), status(403));
    assert.throws(() => fixture.automation.hostedReceive(fixture.facts(), { ...fixture.actor, kind: 'session' }), status(401));
    fixture.policy({ edit: members(fixture.alice.id) }); assert.throws(() => fixture.automation.hostedReceive(fixture.facts(), fixture.actor), status(403));
    fixture.policy({ edit: { kind: 'workspace' } });
    const space = fixture.policies.createSpace({ name: 'Restricted hosted source', view: members(fixture.alice.id), edit: members(fixture.alice.id) }, fixture.alice.id);
    fixture.policy({ spaceId: space.id }); assert.throws(() => fixture.automation.hostedReceive(fixture.facts(), fixture.actor), status(404));
    fixture.policy({ spaceId: 'S1' }); fixture.auth.revokeToken(fixture.bob.id, fixture.token.record.id);
    assert.throws(() => fixture.automation.hostedReceive(facts, fixture.actor), status(401), 'idempotent receipt lookup also rechecks authority');
    assert.equal(fixture.store.database.prepare('SELECT count(*) AS n FROM git_receive_records').get()!.n, 1);
  } finally { await fixture.close(); }
});

test('hosted receive applies push gates and projects hidden rule reasons for the authenticated pusher', async () => {
  const fixture = await automationFixture();
  try {
    const project = fixture.store.createProject({ name: 'PRIVATE gate dependency' }, { principalId: fixture.alice.id, displayName: 'Alice', credentialId: null, requestId: randomUUID() });
    const policy = fixture.policies.policy(project.id, fixture.alice.id);
    fixture.policies.setPolicy(project.id, { expectedVersion: policy.version, spaceId: policy.spaceId, ...policy.rules, view: { kind: 'principals', principalIds: [fixture.alice.id] } }, fixture.alice.id);
    const rule: HeraldRuleInput = { name: 'PRIVATE gate', contentType: 'push-ref', ruleType: 'global', objectId: null, enabled: true, match: 'all', repetition: 'every', conditions: [{ field: 'projectIds', operator: 'none', value: [project.id] }], actions: [{ type: 'block-push', value: 'PRIVATE policy reason' }] };
    fixture.automation.herald.create(rule, fixture.alice.id, fixture.automation.authority);
    const receipt = fixture.automation.hostedReceive(fixture.facts(), fixture.actor);
    assert.equal(receipt.allowed, false); assert.ok(receipt.reasons.length > 0); assert.equal(JSON.stringify(receipt).includes('PRIVATE'), false);
    const stored = fixture.automation.git.receipt(receipt.id, () => true); assert.ok(stored.reasons.includes('PRIVATE policy reason'));
  } finally { await fixture.close(); }
});
