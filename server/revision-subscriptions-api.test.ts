import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { AddressInfo } from 'node:net';
import { createApp } from './app.ts';
import { createAuth } from './auth.ts';
import { Store } from './store.ts';
import type { ActorAttribution, RevisionDetail } from '../shared/types.ts';
import type { FileRecord } from '../shared/files.ts';
import type { SessionState } from '../shared/auth.ts';
import { revisionSubscriptionInput, type RevisionSubscriptionInput, type RevisionSubscriptionSnapshot, type RevisionSubscriptionReceipt, type RevisionSubscriptionHistory, type RevisionMuteHistory, type RevisionSubscriptionPerson } from '../shared/revision-subscriptions.ts';
import { revisionSubscriptionInputHash } from './revision-subscriptions.ts';

const members = (...principalIds: string[]) => ({ kind: 'principals' as const, principalIds }), workspace = { kind: 'workspace' as const };
type ErrorBody = { error: string; code?: string };
async function start(basePath = '/', databasePath = ':memory:', gitRepositories: Record<string, string> = {}) {
  const store = new Store({ path: databasePath });
  const provision = createAuth({ database: store.database, mode: 'local', basePath: '/', provisioning: true });
  const alice = await provision.createAccount({ username: 'alice', displayName: 'Alice Author', password: 'Alice subscription API password long enough' });
  const bob = await provision.createAccount({ username: 'bob', displayName: 'Bob Editor', password: 'Bob subscription API password long enough' });
  const carol = await provision.createAccount({ username: 'carol', displayName: 'Carol Reviewer', password: 'Carol subscription API password long enough' });
  const app = createApp({ store, seed: false, authMode: 'password', basePath, gitRepositories });
  const tokens = { alice: app.auth.createToken(alice.id, { name: 'Author', scopes: ['read', 'write'] }), bob: app.auth.createToken(bob.id, { name: 'Editor', scopes: ['read', 'write'] }), carol: app.auth.createToken(carol.id, { name: 'Reviewer', scopes: ['read', 'write'] }), reader: app.auth.createToken(carol.id, { name: 'Read only', scopes: ['read'] }) };
  const actor: ActorAttribution = { principalId: alice.id, displayName: alice.displayName, credentialId: tokens.alice.record.id, requestId: 'initial-subscription-source' };
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}${basePath.replace(/\/$/, '')}`;
  async function request<T = ErrorBody>(path: string, method = 'GET', body?: unknown, who: keyof typeof tokens = 'alice', key?: string) {
    const response = await fetch(origin + path, { method, signal: AbortSignal.timeout(30_000), headers: { Authorization: `Bearer ${tokens[who].token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as T, headers: response.headers };
  }
  const path = (id: string) => `/api/revisions/${id}/subscriptions`;
  const policy = (id: string, rules: Record<string, unknown>, who = alice.id) => { const current = app.policies.policy(id, who); return app.policies.setPolicy(id, { expectedVersion: current.version, spaceId: current.spaceId, ...current.rules, ...rules }, who); };
  const revision = (kind: 'code' | 'paper' | 'document' = 'code', extra = {}) => {
      const detail = store.createRevision({ testPlan: 'Fixture verification plan.', title: 'Immutable review source', kind, files: [{ path: 'source.txt', content: 'Exact manuscript\n' }], ...extra }, actor);
    policy(detail.revision.id, { view: workspace, edit: members(alice.id, bob.id), interact: workspace }); return detail;
  };
  const input = (id: string, action: RevisionSubscriptionInput['action'], principalId = carol.id): RevisionSubscriptionInput => {
    const snapshot = store.revisionSubscriptions.snapshot(id, principalId);
    return revisionSubscriptionInput({ action, principalId, expectedAuthorVersion: snapshot.authorVersion, expectedReviewerVersion: snapshot.reviewerVersion, expectedAccessEpoch: app.policies.epoch(), ...(['subscribe', 'unsubscribe'].includes(action) ? { expectedSubscriptionVersion: snapshot.viewer.version } : { expectedMuteVersion: snapshot.mute.version }) });
  };
  const act = async (id: string, action: RevisionSubscriptionInput['action'], who: keyof typeof tokens = 'carol', principalId = tokens[who].record.accountId, key: string = crypto.randomUUID()) => { const data = input(id, action, principalId), response = await request<RevisionSubscriptionReceipt>(path(id), 'POST', data, who, key); assert.equal(response.status, 200, JSON.stringify(response.body)); return { data, key, receipt: response.body }; };
  return { ...app, alice, bob, carol, actor, tokens, origin, request, path, policy, revision, input, act, close: async () => { await app.close(); store.close(); } };
}

for (const basePath of ['/', '/mounted/']) test(`self following and private mute preserve source and exact historical receipts at ${basePath}`, async () => {
  const app = await start(basePath);
  try {
    for (const kind of ['code', 'paper', 'document'] as const) {
      const detail = app.revision(kind), id = detail.revision.id;
      app.policy(id, { interact: members(app.alice.id), edit: members(app.alice.id) });
      const before = { versions: app.store.detail(id).versions, reviews: app.store.detail(id).reviews, lifecycle: app.store.revisionLifecycle.state(id), reviewers: app.store.revisionReviewers.state(id), author: app.store.revisionAuthorship.state(id) };
      const original = await app.request<RevisionSubscriptionSnapshot>(app.path(id), 'GET', undefined, 'reader'); assert.equal(original.status, 200); assert.equal(original.headers.get('cache-control'), 'no-store'); assert.equal(original.body.viewer.following, false); assert.equal(original.body.access.capabilities.interact, false); assert.equal(original.body.access.capabilities.edit, false);
      const followed = await app.act(id, 'subscribe'); assert.equal(followed.receipt.kind, 'subscription'); assert.equal(followed.receipt.changed, true); assert.equal(followed.receipt.inputSha256, revisionSubscriptionInputHash(followed.data));
      const noOp = await app.act(id, 'subscribe'); assert.equal(noOp.receipt.changed, false); assert.equal(noOp.receipt.transaction, null);
      const muted = await app.act(id, 'mute'); assert.equal(muted.receipt.kind, 'mute'); if (muted.receipt.kind === 'mute') assert.equal(muted.receipt.mute.muted, true);
      const state = (await app.request<{ followingRevisionIds: string[] }>('/api/state', 'GET', undefined, 'carol')).body; assert.ok(state.followingRevisionIds.includes(id), 'mute never changes following membership');
      await app.act(id, 'unsubscribe'); await app.act(id, 'unmute');
      for (const saved of [followed, noOp, muted]) { const replay = await app.request<RevisionSubscriptionReceipt>(app.path(id), 'POST', saved.data, 'carol', saved.key); assert.equal(replay.status, 200); assert.deepEqual(replay.body, { ...saved.receipt, accessEpoch: app.policies.epoch() }); }
      assert.deepEqual({ versions: app.store.detail(id).versions, reviews: app.store.detail(id).reviews, lifecycle: app.store.revisionLifecycle.state(id), reviewers: app.store.revisionReviewers.state(id), author: app.store.revisionAuthorship.state(id) }, before);
      assert.equal((await app.request<{ followingRevisionIds: string[] }>('/api/state', 'GET', undefined, 'carol')).body.followingRevisionIds.includes(id), false);
    }
  } finally { await app.close(); }
});

test('self actions require View, adding others Interact or Edit, removing others Edit, and disabled followers remain removable', async () => {
  const app = await start();
  try {
    const id = app.revision().revision.id;
    app.policy(id, { edit: members(app.alice.id, app.bob.id), interact: members(app.carol.id) });
    assert.equal((await app.request(app.path(id), 'POST', app.input(id, 'subscribe'), 'reader', 'read-only')).status, 403);
    const addedByInteractor = await app.act(id, 'subscribe', 'carol', app.bob.id); // Interact, no Edit.
    assert.equal((await app.request(app.path(id), 'POST', app.input(id, 'unsubscribe', app.bob.id), 'carol', 'remove-other')).status, 403);
    await app.act(id, 'subscribe', 'bob', app.carol.id); // Edit, no Interact.
    assert.equal((await app.request(app.path(id), 'POST', app.input(id, 'mute', app.bob.id), 'carol', 'private-mute')).status, 403);
    app.policy(id, { edit: members(app.alice.id), interact: members(app.alice.id) });
    assert.equal((await app.request(app.path(id), 'POST', app.input(id, 'subscribe', app.bob.id), 'carol', 'no-other-authority')).status, 403);
    assert.equal((await app.request(app.path(id), 'POST', addedByInteractor.data, 'carol', addedByInteractor.key)).status, 403);
    await app.act(id, 'unsubscribe', 'carol'); await app.act(id, 'mute', 'carol');
    app.policy(id, { edit: members(app.alice.id, app.bob.id) }); const beforeDisable = await app.act(id, 'subscribe', 'bob', app.carol.id);
    app.auth.setAccountDisabled(app.carol.id, true); await app.act(id, 'unsubscribe', 'bob', app.carol.id);
    assert.equal((await app.request(app.path(id), 'POST', beforeDisable.data, 'bob', beforeDisable.key)).status, 200, 'saved addition remains historical after the recipient is disabled');
    assert.equal((await app.request(app.path(id), 'POST', app.input(id, 'subscribe', app.carol.id), 'bob', 'disabled-add')).status, 400);
    assert.equal((await app.request(app.path(id) + '/person?principalId=missing', 'GET', undefined, 'bob')).status, 400);
    assert.equal((await app.request(app.path(id), 'GET', undefined, 'bob')).status, 200);
  } finally { await app.close(); }
});

test('automatic author and reviewer following is separate from explicit edges and self mute', async () => {
  const app = await start();
  try {
    const id = app.revision().revision.id;
    for (const action of ['subscribe', 'unsubscribe'] as const) assert.equal((await app.request(app.path(id), 'POST', app.input(id, action, app.alice.id), 'alice', action)).status, 409);
    await app.act(id, 'mute', 'alice'); await app.act(id, 'subscribe', 'bob', app.alice.id); await app.act(id, 'unsubscribe', 'bob', app.alice.id);
    assert.deepEqual(app.store.revisionSubscriptions.status(id, app.alice.id).automatic, ['author']); assert.equal(app.store.revisionSubscriptions.effective(id, app.alice.id), true);
    const beforeRole = await app.act(id, 'subscribe');
    const reviewer = app.store.revisionReviewers.snapshot(id, app.alice.id);
    app.store.revisionReviewers.mutate(id, { action: 'add', reviewerId: app.carol.id, message: '', expectedReviewerVersion: reviewer.reviewers.version, expectedLifecycleVersion: reviewer.lifecycle.version, expectedAuthorVersion: reviewer.authorship.version, expectedVersion: reviewer.head.number, expectedVersionId: reviewer.head.versionId, expectedContentHash: reviewer.head.contentHash, expectedAccessEpoch: app.policies.epoch(), expectedConfigId: reviewer.configId, expectedEvidenceSha256: reviewer.evidence.sha256 }, app.actor, { principalId: app.carol.id, displayName: app.carol.displayName });
    const snapshot = (await app.request<RevisionSubscriptionSnapshot>(app.path(id), 'GET', undefined, 'carol')).body; assert.deepEqual(snapshot.viewer.automatic, ['reviewer']);
    assert.equal((await app.request(app.path(id), 'POST', beforeRole.data, 'carol', beforeRole.key)).status, 200, 'saved self-follow remains recoverable after becoming an automatic follower');
    assert.equal((await app.request(app.path(id), 'POST', app.input(id, 'unsubscribe'), 'carol', 'automatic-reviewer')).status, 409); await app.act(id, 'mute');
  } finally { await app.close(); }
});

test('mute changes never alter another viewer snapshot, public history, public counters, activity or person lookup', async () => {
  const app = await start();
  try {
    const id = app.revision().revision.id; await app.act(id, 'subscribe');
    const readPublic = async () => ({ snapshot: (await app.request(app.path(id), 'GET', undefined, 'bob')).body, history: (await app.request(app.path(id) + '/history', 'GET', undefined, 'bob')).body, person: (await app.request(app.path(id) + `/person?principalId=${app.carol.id}`, 'GET', undefined, 'bob')).body, activity: app.store.detail(id).activity });
    const before = await readPublic(); await app.act(id, 'mute'); const noOp = await app.act(id, 'mute'); assert.equal(noOp.receipt.changed, false); assert.equal(noOp.receipt.transaction, null); assert.deepEqual(await readPublic(), before);
    const mine = (await app.request<RevisionMuteHistory>(app.path(id) + '/mute-history', 'GET', undefined, 'carol')).body; assert.equal(mine.principalId, app.carol.id); assert.equal(mine.transactions.length, 1);
    const other = (await app.request<RevisionMuteHistory>(app.path(id) + '/mute-history', 'GET', undefined, 'bob')).body; assert.equal(other.principalId, app.bob.id); assert.equal(other.muteVersion, 0); assert.deepEqual(other.transactions, []);
    for (const suffix of [`?principalId=${app.carol.id}`, `/history?principalId=${app.carol.id}`, `/mute-history?principalId=${app.carol.id}`, `/person?principalId=${app.carol.id}&mute=true`]) assert.equal((await app.request(app.path(id) + suffix, 'GET', undefined, 'bob')).status, 400);
  } finally { await app.close(); }
});

test('person lookup pins unsubscribed members; paging and role/source concurrency are exact without unnecessary source pins', async () => {
  const app = await start();
  try {
    const id = app.revision().revision.id; await app.act(id, 'subscribe'); await app.act(id, 'unsubscribe'); await app.act(id, 'subscribe', 'bob');
    const person = await app.request<RevisionSubscriptionPerson>(app.path(id) + `/person?principalId=${app.carol.id}`, 'GET', undefined, 'bob'); assert.equal(person.status, 200); assert.equal(person.body.status.state, 'unsubscribed'); assert.equal(person.body.status.version, 2); assert.equal('mute' in person.body, false);
    const inspected = app.input(id, 'subscribe'); app.store.createVersion(id, { expectedVersion: 1, message: 'Later source', files: [{ path: 'source.txt', content: 'Later manuscript\n' }] }, app.actor);
    assert.equal((await app.request(app.path(id), 'POST', inspected, 'carol', 'source-independent')).status, 200);
    const current = (await app.request<RevisionSubscriptionSnapshot>(app.path(id), 'GET', undefined, 'bob')).body;
    const query = `limit=1&expectedSubscriptionVersion=${current.subscriptionVersion}&expectedAuthorVersion=${current.authorVersion}&expectedReviewerVersion=${current.reviewerVersion}`;
    const first = (await app.request<RevisionSubscriptionSnapshot>(app.path(id) + '?' + query, 'GET', undefined, 'bob')).body; assert.equal(first.subscribers.length, 1); assert.ok(first.nextAfter);
    const second = (await app.request<RevisionSubscriptionSnapshot>(app.path(id) + '?' + query + '&after=' + encodeURIComponent(first.nextAfter!), 'GET', undefined, 'bob')).body; assert.equal(second.subscribers.length, 1); assert.notEqual(first.subscribers[0]!.principalId, second.subscribers[0]!.principalId);
    const history = (await app.request<RevisionSubscriptionHistory>(app.path(id) + `/history?limit=1&expectedSubscriptionVersion=${current.subscriptionVersion}`)).body; assert.equal(history.transactions.length, 1); assert.ok(history.nextBefore);
    const next = (await app.request<RevisionSubscriptionHistory>(app.path(id) + `/history?limit=1&before=${history.nextBefore}&expectedSubscriptionVersion=${current.subscriptionVersion}`)).body; assert.ok(next.transactions[0]!.subscriptionVersion < history.transactions[0]!.subscriptionVersion);
    const race = app.input(id, 'unsubscribe'), results = await Promise.all(['one', 'two'].map(key => app.request(app.path(id), 'POST', race, 'carol', key))); assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
    assert.equal((await app.request(app.path(id) + '?' + query)).status, 409);
    for (const suffix of ['?extra=1', '?limit=101', '?limit=1&limit=2', '?after=', '/history?before=0', '/mute-history?expectedMuteVersion=-1', '/person', '/person?principalId=a&principalId=b']) assert.equal((await app.request(app.path(id) + suffix)).status, 400, suffix);
    for (const patch of [{ expectedAuthorVersion: 999 }, { expectedReviewerVersion: 999 }, { expectedAccessEpoch: 999 }, { expectedSubscriptionVersion: 999 }]) assert.equal((await app.request(app.path(id), 'POST', { ...app.input(id, 'subscribe'), ...patch }, 'carol', crypto.randomUUID())).status, 409);
    assert.equal((await app.request(app.path(id), 'POST', app.input(id, 'subscribe'), 'carol')).status, 400);
    assert.equal((await app.request(app.path(id), 'POST', { ...app.input(id, 'subscribe'), expectedVersion: 2 }, 'carol', 'unneeded-source-pin')).status, 400);
  } finally { await app.close(); }
});

test('human comments follow implicitly once, while explicit opt-outs and review runs remain separate', async () => {
  const app = await start();
  try {
    const detail = app.revision(), id = detail.revision.id, versionId = detail.versions[0]!.id;
    const first = await app.request<{ id: string }>(`/api/revisions/${id}/comments`, 'POST', { versionId, body: 'Human discussion' }, 'carol', 'human-comment'); assert.equal(first.status, 201); assert.equal(app.store.revisionSubscriptions.effective(id, app.carol.id), true);
    const history = app.store.revisionSubscriptions.history(id); assert.equal(history.transactions.length, 1); assert.equal(history.transactions[0]!.reason, 'comment'); assert.equal(history.transactions[0]!.commentId, first.body.id);
    assert.equal((await app.request(`/api/revisions/${id}/comments`, 'POST', { versionId, body: 'Human discussion' }, 'carol', 'human-comment')).status, 201); assert.deepEqual(app.store.revisionSubscriptions.history(id), history);
    await app.act(id, 'unsubscribe'); const optedOut = app.store.revisionSubscriptions.history(id); assert.equal((await app.request(`/api/revisions/${id}/comments`, 'POST', { versionId, body: 'Remain opted out' }, 'carol', 'another-comment')).status, 201); assert.deepEqual(app.store.revisionSubscriptions.history(id), optedOut);
    app.store.saveReview(id, 1, { provider: 'local', model: 'text-checks-v2', summary: 'Deterministic evidence', findings: [] }, { ...app.actor, principalId: app.bob.id, displayName: app.bob.displayName }); assert.equal(app.store.revisionSubscriptions.effective(id, app.bob.id), false);
  } finally { await app.close(); }
});

test('saved following receipts bind exact operation, principal and private preference without loading hidden source', async () => {
  const app = await start();
  try {
    const id = app.revision().revision.id, saved = await app.act(id, 'subscribe', 'carol', app.carol.id, 'protected-follow');
    const other = app.revision().revision.id, foreign = await app.act(other, 'subscribe'); app.policy(other, { view: members(app.alice.id) });
    const row = app.store.database.prepare('SELECT key,body FROM idempotency WHERE key LIKE ?').get('%:protected-follow') as { key: string; body: string }, getter = app.store.revisionSubscriptions.operation.bind(app.store.revisionSubscriptions); let hiddenLoads = 0;
    app.store.revisionSubscriptions.operation = operationId => { if (operationId === foreign.receipt.operationId) { hiddenLoads++; throw new Error('Hidden operation loaded'); } return getter(operationId); };
    for (const body of [foreign.receipt, { ...saved.receipt, operationId: foreign.receipt.operationId }, { ...saved.receipt, inputSha256: 'f'.repeat(64) }, { ...saved.receipt, changed: false, transaction: null }]) { app.store.database.prepare('UPDATE idempotency SET body=? WHERE key=?').run(JSON.stringify(body), row.key); assert.equal((await app.request(app.path(id), 'POST', saved.data, 'carol', saved.key)).status, 409); }
    assert.equal(hiddenLoads, 0); app.store.database.prepare('UPDATE idempotency SET body=? WHERE key=?').run(row.body, row.key);
    const old = app.tokens.carol.record.id; app.tokens.carol = app.auth.createToken(app.carol.id, { name: 'Rotated', scopes: ['read', 'write'] }); app.auth.revokeToken(app.carol.id, old);
    const retry = await app.request<RevisionSubscriptionReceipt>(app.path(id), 'POST', saved.data, 'carol', saved.key); assert.equal(retry.status, 200); assert.deepEqual(retry.body.transaction, saved.receipt.transaction);
    const mute = await app.act(id, 'mute', 'carol', app.carol.id, 'private-mute'), original = app.store.database.prepare('SELECT * FROM idempotency WHERE key LIKE ?').get('%:private-mute')!;
    const stolen = `${app.auth.workspaceId}:${app.bob.id}:stolen-mute`; app.store.database.prepare('INSERT INTO idempotency(key,fingerprint,status,body,created_at) VALUES(?,?,?,?,?)').run(stolen, original.fingerprint as string, original.status as number, original.body as string, original.created_at as string);
    assert.equal((await app.request(app.path(id), 'POST', mute.data, 'bob', 'stolen-mute')).status, 403);
    app.policy(id, { view: members(app.alice.id) }); const denied = await app.request(app.path(id), 'POST', saved.data, 'carol', saved.key); assert.equal(denied.status, 404); assert.deepEqual(denied.body, (await app.request('/api/revisions/D999999/subscriptions', 'POST', saved.data, 'carol', saved.key)).body);
  } finally { await app.close(); }
});

test('same-input no-op receipts are bound to their own scoped retry key', async () => {
  const app = await start();
  try {
    const id = app.revision().revision.id;
    await app.act(id, 'subscribe');
    const first = await app.act(id, 'subscribe', 'carol', app.carol.id, 'original-noop');
    await app.act(id, 'subscribe', 'bob');
    const later = await app.act(id, 'subscribe', 'carol', app.carol.id, 'later-noop');
    assert.deepEqual(first.data, later.data);
    assert.equal(first.receipt.changed, false); assert.equal(later.receipt.changed, false);
    assert.equal(first.receipt.kind, 'subscription'); assert.equal(later.receipt.kind, 'subscription');
    if (first.receipt.kind !== 'subscription' || later.receipt.kind !== 'subscription') assert.fail('Expected subscription receipts.');
    assert.ok(later.receipt.subscriptionVersion > first.receipt.subscriptionVersion);
    const saved = app.store.database.prepare('SELECT * FROM idempotency WHERE key LIKE ?').get('%:original-noop') as { key: string; body: string };
    const before = app.store.revisionSubscriptions.history(id), forgedBody = JSON.stringify(later.receipt);
    app.store.database.prepare('UPDATE idempotency SET body=? WHERE key=?').run(forgedBody, saved.key);
    const forged = app.store.database.prepare('SELECT * FROM idempotency WHERE key=?').get(saved.key);
    const denied = await app.request(app.path(id), 'POST', first.data, 'carol', first.key);
    assert.equal(denied.status, 409); assert.equal(denied.body.code, 'REVISION_SUBSCRIPTION_INVALID_RECEIPT');
    assert.deepEqual(app.store.database.prepare('SELECT * FROM idempotency WHERE key=?').get(saved.key), forged, 'rejected replay must preserve the stored record');
    assert.deepEqual(app.store.revisionSubscriptions.history(id), before);
    app.store.database.prepare('UPDATE idempotency SET body=? WHERE key=?').run(saved.body, saved.key);
    const recovered = await app.request<RevisionSubscriptionReceipt>(app.path(id), 'POST', first.data, 'carol', first.key);
    assert.equal(recovered.status, 200); assert.deepEqual(recovered.body, first.receipt);
    assert.equal('retryKeySha256' in recovered.body, false, 'internal retry binding is never part of the public receipt');
  } finally { await app.close(); }
});

test('repository, revision Space and historical Word File ceilings apply to following reads, state filters and retries', async () => {
  const app = await start();
  try {
    const bytes = await readFile(new URL('../tests/fixtures/docx/roundtrip.docx', import.meta.url));
    for (const ceiling of ['repository', 'space', 'file'] as const) {
      let id: string, fileId: string | undefined;
      const repository = app.store.createRepository({ name: 'Following source', remoteUrl: 'https://example.test/source.git', description: '', defaultBranch: 'main' });
      if (ceiling === 'file') {
        const upload = await app.request<FileRecord>('/api/files', 'POST', { name: 'Follow.docx', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), dataBase64: bytes.toString('base64') }, 'alice', 'word-follow-file'); assert.equal(upload.status, 201); fileId = upload.body.id;
        const imported = await app.request<RevisionDetail>('/api/revisions/docx', 'POST', { testPlan: 'Inspect pages.', title: 'Follow Word source', sourceFile: { fileId, bytes: upload.body.bytes, sha256: upload.body.sha256 }, shareSource: true, expectedAccessEpoch: app.policies.epoch() }, 'alice', 'word-follow'); assert.equal(imported.status, 201); id = imported.body.revision.id;
      } else id = app.revision('paper', { repositoryId: repository.id }).revision.id;
      const saved = await app.act(id, 'subscribe');
      if (ceiling === 'repository') app.policy(repository.id, { view: members(app.alice.id) });
      else { const space = app.policies.createSpace({ name: 'Private following source', view: members(app.alice.id), edit: members(app.alice.id) }, app.alice.id); app.policy(fileId ?? id, { spaceId: space.id }); }
      for (const suffix of ['', '/history', '/mute-history', `/person?principalId=${app.carol.id}`]) assert.equal((await app.request(app.path(id) + suffix, 'GET', undefined, 'carol')).status, 404);
      assert.equal((await app.request(app.path(id), 'POST', saved.data, 'carol', saved.key)).status, 404); assert.equal((await app.request<{ followingRevisionIds: string[] }>('/api/state', 'GET', undefined, 'carol')).body.followingRevisionIds.includes(id), false);
    }
  } finally { await app.close(); }
});

test('cookie-authenticated following preferences require the current session context and CSRF token', async () => {
  const app = await start(); const cookies = new Map<string, string>();
  const acceptCookies = (headers: Headers) => { for (const cookie of headers.getSetCookie()) { const pair = cookie.split(';')[0]!, split = pair.indexOf('='), name = pair.slice(0, split); if (/max-age=0(?:;|$)/i.test(cookie)) cookies.delete(name); else cookies.set(name, pair.slice(split + 1)); } };
  const cookieHeader = () => [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  try {
    const id = app.revision().revision.id;
    const bootstrap = await fetch(app.origin + '/api/session'); acceptCookies(bootstrap.headers); const boot = await bootstrap.json() as SessionState;
    const login = await fetch(app.origin + '/api/login', { method: 'POST', headers: { Cookie: cookieHeader(), Origin: app.origin, 'Content-Type': 'application/json', 'X-CSRF-Token': boot.csrfToken! }, body: JSON.stringify({ username: 'bob', password: 'Bob subscription API password long enough' }) }); assert.equal(login.status, 200); acceptCookies(login.headers); const session = await login.json() as SessionState;
    const data = app.input(id, 'subscribe', app.bob.id), headers = { Cookie: cookieHeader(), Origin: app.origin, 'Content-Type': 'application/json', 'Idempotency-Key': 'cookie-follow', 'X-Session-Context': session.sessionContext!, 'X-CSRF-Token': session.csrfToken! };
    for (const [invalid, status] of [[{ ...headers, 'X-CSRF-Token': 'invalid' }, 403], [{ ...headers, 'X-Session-Context': 'other-session' }, 401]] as const) assert.equal((await fetch(app.origin + app.path(id), { method: 'POST', headers: invalid, body: JSON.stringify(data) })).status, status);
    const saved = await fetch(app.origin + app.path(id), { method: 'POST', headers, body: JSON.stringify(data) }); assert.equal(saved.status, 200); assert.equal(app.store.revisionSubscriptions.effective(id, app.bob.id), true);
  } finally { await app.close(); }
});

test('following authorization is checked under the SQLite writer lock for fresh and saved requests', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'phab-subscription-lock-')), databasePath = join(directory, 'workspace.sqlite'), app = await start('/', databasePath), transaction = app.store.transaction.bind(app.store);
  try {
    for (const phase of ['fresh', 'replay'] as const) {
      const id = app.revision().revision.id, data = app.input(id, 'subscribe', app.carol.id), key = `subscription-lock-${phase}`;
      let replay: { key: string; fingerprint: string; status: number; body: string; created_at: string } | undefined;
      if (phase === 'replay') { assert.equal((await app.request(app.path(id), 'POST', data, 'bob', key)).status, 200); replay = app.store.database.prepare('SELECT * FROM idempotency WHERE key LIKE ?').get(`%:${key}`) as typeof replay; assert.ok(replay); app.store.database.prepare('DELETE FROM idempotency WHERE key=?').run(replay.key); }
      const original = app.policies.policy(id, app.alice.id), policy = { ...original, version: original.version + 1, rules: { ...original.rules, edit: members(app.alice.id), interact: members(app.alice.id) } }, before = app.store.detail(id), history = app.store.revisionSubscriptions.history(id);
      const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(`
        import { parentPort, workerData } from 'node:worker_threads'; import { DatabaseSync } from 'node:sqlite';
        const db=new DatabaseSync(workerData.databasePath);db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');db.prepare('UPDATE object_policies SET data=? WHERE object_id=?').run(JSON.stringify(workerData.policy),workerData.policy.objectId);db.prepare("UPDATE policy_meta SET value=value+1 WHERE name='epoch'").run();
        if(workerData.replay){const r=workerData.replay;db.prepare('INSERT INTO idempotency(key,fingerprint,status,body,created_at) VALUES(?,?,?,?,?)').run(r.key,r.fingerprint,r.status,r.body,r.created_at);}parentPort.once('message',()=>{db.exec('COMMIT');db.close();parentPort.close();});parentPort.postMessage('locked');
      `)}`), { workerData: { databasePath, policy, replay } });
      try {
        assert.deepEqual(await once(worker, 'message'), ['locked']); let entered = 0;
        app.store.transaction = function<T>(work: () => T): T { entered++; app.store.transaction = transaction; worker.postMessage('commit'); return transaction(work); };
        const denied = await app.request(app.path(id), 'POST', data, 'bob', key); assert.equal(entered, 1); assert.equal(denied.status, 403); assert.deepEqual(app.store.detail(id), before); assert.deepEqual(app.store.revisionSubscriptions.history(id), history);
      } finally { app.store.transaction = transaction; await worker.terminate(); }
    }
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
