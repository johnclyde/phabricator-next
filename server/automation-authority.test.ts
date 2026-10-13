import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp } from './app.ts';
import { createAuth } from './auth.ts';
import { Store } from './store.ts';
import type { GitObserver } from './git.ts';
import type { GitCommitResult } from '../shared/repositories.ts';
import type { BuildPlan } from '../shared/harbormaster.ts';
import { HttpError } from './validation.ts';

function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const observed: GitCommitResult = { repositoryId: 'R1', objectFormat: 'sha1', commit: { id: 'a'.repeat(40), treeId: 'b'.repeat(40), parentIds: [], author: { name: 'Private author', email: 'private@example.test', timestamp: '2026-01-01T00:00:00Z' }, committer: { name: 'Private author', email: 'private@example.test', timestamp: '2026-01-01T00:00:00Z' }, message: 'Private commit message', messageTruncated: false } };
const unavailable = async (): Promise<never> => { throw new HttpError(503, 'Unused test observer method.'); };
const workspace = { kind: 'workspace' as const };

test('commit build observation rechecks revoked credentials and repository access on both success and failure', async () => {
  const store = new Store({ path: ':memory:' }), provision = createAuth({ database: store.database, mode: 'local', basePath: '/', provisioning: true });
  const alice = await provision.createAccount({ username: 'alice', displayName: 'Alice', password: 'Alice commit authority test password' });
  const bob = await provision.createAccount({ username: 'bob', displayName: 'Bob', password: 'Bob commit authority test password' });
  let entered = deferred<void>(), completion = deferred<GitCommitResult>();
  const observer: GitObserver = { info: unavailable, refs: unavailable, tree: unavailable, blob: unavailable, blame: unavailable, history: unavailable, compare: unavailable, patch: unavailable, compareFile: unavailable, importSnapshot: unavailable, commit: async () => { entered.resolve(); return completion.promise; } };
  const app = createApp({ store, seed: false, authMode: 'password', gitObserver: observer });
  store.createRepository({ name: 'Authority source', remoteUrl: 'https://example.invalid/not-fetched.git' });
  const aliceToken = app.auth.createToken(alice.id, { name: 'Configure plan', scopes: ['read', 'write'] });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const request = async (path: string, input: unknown, bearer: string) => { const response = await fetch(origin + path, { method: 'POST', signal: AbortSignal.timeout(10_000), headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(input) }); return { status: response.status, body: await response.json() as Record<string, unknown> }; };
  const setPolicy = (privateSource: boolean) => { const current = app.policies.policy('R1', alice.id), members = { kind: 'principals' as const, principalIds: [alice.id] }; app.policies.setPolicy('R1', { expectedVersion: current.version, spaceId: current.spaceId, view: privateSource ? members : workspace, edit: privateSource ? members : workspace, interact: privateSource ? members : workspace }, alice.id); };
  try {
    const configured = await request('/api/harbormaster/plans', { name: 'Observed commit', description: '', enabled: true, steps: [{ key: 'worker', name: 'Worker', kind: 'external', dependsOn: [], worker: 'test' }] }, aliceToken.token); assert.equal(configured.status, 201);
    const plan = configured.body.plan as BuildPlan, input = { repositoryId: 'R1', commitId: observed.commit.id, planId: plan.id, planVersion: plan.version };
    for (const change of ['token', 'repository'] as const) for (const outcome of ['success', 'failure'] as const) {
      setPolicy(false); entered = deferred<void>(); completion = deferred<GitCommitResult>();
      const token = app.auth.createToken(bob.id, { name: `${change}-${outcome}`, scopes: ['read', 'write'] });
      const pending = request('/api/harbormaster/builds', input, token.token); await entered.promise;
      if (change === 'token') app.auth.revokeToken(bob.id, token.record.id); else setPolicy(true);
      if (outcome === 'success') completion.resolve(observed); else completion.reject(new HttpError(422, 'Private commit decode failure detail.', 'PRIVATE_OBSERVER_FAILURE'));
      const response = await pending; assert.equal(response.status, change === 'token' ? 401 : 404, `${change}/${outcome}: ${JSON.stringify(response)}`);
      assert.equal(JSON.stringify(response.body).includes('Private'), false); assert.equal(response.body.code === 'PRIVATE_OBSERVER_FAILURE', false);
      assert.equal(store.database.prepare('SELECT count(*) AS count FROM harbormaster_builds').get()!.count, 0, 'revoked observation creates no build, target or buildable');
      assert.equal(store.database.prepare('SELECT count(*) AS count FROM harbormaster_buildables').get()!.count, 0);
    }
  } finally { await app.close(); store.close(); }
});
