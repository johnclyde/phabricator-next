import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from './app.ts';
import { createAuth } from './auth.ts';
import { Store } from './store.ts';
import type { ActorAttribution, AppState } from '../shared/types.ts';
import type { RevisionReviewerAction, RevisionReviewerInput } from '../shared/revision-reviewers.ts';
import { evaluateRevisionActive, validateRevisionActiveSnapshot } from '../shared/revision-active.ts';
import { lifecycleAction } from '../tests/revision-lifecycle-fixture.ts';

async function fixture(basePath = '/') {
  const store = new Store({ path: ':memory:' });
  const provision = createAuth({ database: store.database, mode: 'local', basePath, provisioning: true });
  const accounts: Awaited<ReturnType<typeof provision.createAccount>>[] = [];
  for (const username of ['alice', 'bob', 'carol']) accounts.push(await provision.createAccount({ username, displayName: `${username} private fixture person`, password: `A long independent ${username} active queue password` }));
  const app = createApp({ store, seed: false, authMode: 'password', basePath });
  const tokens = accounts.map(account => app.auth.createToken(account.id, { name: 'Read personal queue', scopes: ['read'] }));
  const actors: ActorAttribution[] = accounts.map(account => ({ principalId: account.id, displayName: account.displayName, credentialId: null, requestId: `fixture-${account.username}` }));
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}${basePath}`;
  const state = async (index = 0) => {
    const response = await fetch(`${origin}api/state`, { headers: { Authorization: `Bearer ${tokens[index]!.token}` }, signal: AbortSignal.timeout(15_000) });
    return { status: response.status, headers: response.headers, body: await response.json() as AppState };
  };
  const create = (title = 'Private exact source title') => store.createRevision({ kind: 'paper', title, testPlan: 'Verify personal responsibility without expanding data access.', files: [{ path: 'paper.tex', content: 'Never expose this full source through queue metadata.\n' }] }, actors[0]);
  const action = (id: string, action: RevisionReviewerAction, actorIndex = 1, targetIndex?: number) => {
    const snapshot = store.revisionReviewers.snapshot(id), target = targetIndex === undefined ? undefined : accounts[targetIndex]!;
    const input: RevisionReviewerInput = { action, ...(['add', 'remove', 'block', 'unblock'].includes(action) ? { reviewerId: target!.id } : {}), message: 'Exact fixture reviewer action', expectedReviewerVersion: snapshot.reviewers.version, expectedLifecycleVersion: snapshot.lifecycle.version, expectedAuthorVersion: snapshot.authorship.version, expectedVersion: snapshot.head.number, expectedVersionId: snapshot.head.versionId, expectedContentHash: snapshot.head.contentHash, expectedAccessEpoch: app.policies.epoch(), expectedConfigId: snapshot.configId, expectedEvidenceSha256: snapshot.evidence.sha256 } as RevisionReviewerInput;
    return store.revisionReviewers.mutate(id, input, actors[actorIndex]!, target && { principalId: target.id, displayName: target.displayName });
  };
  return { ...app, store, accounts, tokens, actors, state, create, action, close: async () => { await app.close(); store.close(); } };
}

for (const basePath of ['/', '/mounted/']) test(`personal Active state stays read-scoped, uncached and subject to credential retirement at ${basePath}`, async () => {
  const f = await fixture(basePath);
  try {
    const id = f.create().revision.id; f.action(id, 'add', 0, 1);
    const author = await f.state(), reviewer = await f.state(1);
    assert.equal(author.status, 200); assert.equal(reviewer.status, 200);
    assert.equal(reviewer.headers.get('cache-control'), 'no-store');
    assert.equal(validateRevisionActiveSnapshot(author.body.revisionActive, author.body), true);
    assert.equal(validateRevisionActiveSnapshot(reviewer.body.revisionActive, reviewer.body), true);
    assert.equal(author.body.revisionActive!.principalId, f.accounts[0]!.id);
    assert.equal(reviewer.body.revisionActive!.principalId, f.accounts[1]!.id);
    assert.equal(validateRevisionActiveSnapshot(author.body.revisionActive, reviewer.body), false, 'A real valid snapshot from another principal cannot be reused.');
    f.auth.revokeToken(f.accounts[1]!.id, f.tokens[1]!.record.id);
    const revoked = await f.state(1); assert.equal(revoked.status, 401); assert.equal('revisionActive' in revoked.body, false);
    f.auth.setAccountDisabled(f.accounts[0]!.id, true);
    const disabled = await f.state(); assert.equal(disabled.status, 401); assert.equal('revisionActive' in disabled.body, false);
  } finally { await f.close(); }
});

test('Active projection omits other reviewer identities and does not expand hidden revision metadata', async () => {
  const f = await fixture();
  try {
    const visible = f.create('Visible responsibility').revision.id, hidden = f.create('Hidden responsibility title').revision.id;
    for (const id of [visible, hidden]) { f.action(id, 'add', 0, 1); f.action(id, 'add', 0, 2); }
    const before = f.policies.policy(hidden, f.accounts[0]!.id);
    f.policies.setPolicy(hidden, { expectedVersion: before.version, spaceId: before.spaceId, ...before.rules, view: { kind: 'principals', principalIds: [f.accounts[0]!.id] } }, f.accounts[0]!.id);
    const response = await f.state(1); assert.equal(response.status, 200);
    assert.equal(validateRevisionActiveSnapshot(response.body.revisionActive, response.body), true);
    const projection = response.body.revisionActive!, encoded = JSON.stringify(projection);
    assert.deepEqual(projection.items.map(item => item.revisionId), [visible]);
    for (const privateValue of [hidden, f.accounts[0]!.id, f.accounts[2]!.id, ...f.accounts.map(account => account.displayName), 'Never expose this full source', 'Hidden responsibility title']) assert.equal(encoded.includes(privateValue), false, privateValue);
    assert.equal(projection.items[0]!.isAuthor, false); assert.equal(projection.items[0]!.reviewerStatus, 'added');
    const result = evaluateRevisionActive(response.body, 'paper'); assert.equal(result.available, true);
    if (result.available) assert.deepEqual(result.groups.flatMap(group => group.revisions.map(revision => revision.id)), [visible]);
  } finally { await f.close(); }
});

test('Active uses exact scalar source and role state without loading full review evidence', async () => {
  const f = await fixture();
  try {
    const detail = f.create(), id = detail.revision.id; f.action(id, 'add', 0, 1);
    f.store.saveReview(id, 1, { provider: 'local', model: 'fixture', summary: 'Recorded evidence should not enter the queue.', findings: [] }, f.actors[0]);
    f.store.revisionLifecycle.snapshot = () => { throw new Error('Queue must not load lifecycle review evidence'); };
    f.store.revisionReviewers.snapshot = () => { throw new Error('Queue must not load full reviewer presentation'); };
    const response = await f.state(1); assert.equal(response.status, 200, JSON.stringify(response.body));
    const projection = response.body.revisionActive!; assert.equal(validateRevisionActiveSnapshot(projection, response.body), true);
    assert.deepEqual(projection.items[0]!.head, { versionId: detail.versions[0]!.id, number: 1, contentHash: detail.versions[0]!.contentHash });
    assert.equal(JSON.stringify(projection).includes('Recorded evidence'), false);
  } finally { await f.close(); }
});

test('requesting review retires a rejection veto but preserves the reviewer Must Review responsibility', async () => {
  const f = await fixture();
  try {
    const id = f.create().revision.id; f.action(id, 'request_changes');
    lifecycleAction(f.store, id, 'plan_changes', f.actors[0]!);
    lifecycleAction(f.store, id, 'request_review', f.actors[0]!);
    const reviewerState = f.store.revisionReviewers.state(id);
    assert.equal(reviewerState.members[0]!.status, 'rejected'); assert.equal(reviewerState.members[0]!.decision!.invalidated!.reason, 'request_review');
    assert.equal(f.store.revisionLifecycle.snapshot(id).reviewers.olderRejecting, 0, 'This old rejection no longer vetoes acceptance.');
    const response = await f.state(1); assert.equal(response.status, 200);
    assert.equal(response.body.revisionActive!.items[0]!.decisionCurrent, false);
    const result = evaluateRevisionActive(response.body, 'paper'); assert.equal(result.available, true);
    if (result.available) {
      assert.deepEqual(result.groups.find(group => group.key === 'must-review')!.revisions.map(revision => revision.id), [id]);
      assert.equal(result.groups.find(group => group.key === 'ready-to-review')!.revisions.length, 0);
    }
  } finally { await f.close(); }
});
