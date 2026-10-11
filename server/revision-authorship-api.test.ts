import { lifecycleAction, closeRevision } from '../tests/revision-lifecycle-fixture.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { registerFilePolicy } from './policy.ts';
import type { AddressInfo } from 'node:net';
import { createApp } from './app.ts';
import { createAuth } from './auth.ts';
import { Store } from './store.ts';
import type { ActorAttribution } from '../shared/types.ts';
import type { RevisionAuthorInput, RevisionAuthorReceipt, RevisionAuthorResult, RevisionAuthorshipSnapshot, RevisionAuthorHistory } from '../shared/revision-authorship.ts';
import { revisionAuthorInputHash } from './revision-authorship.ts';

const members = (...principalIds: string[]) => ({ kind: 'principals' as const, principalIds });
const workspace = { kind: 'workspace' as const };
type ErrorBody = { error: string; code?: string };
async function start(basePath = '/', closeOnAccept = false) {
  const store = new Store({ path: ':memory:', revisionLifecycle: { closeOnAccept } });
  const provision = createAuth({ database: store.database, mode: 'local', basePath: '/', provisioning: true });
  const alice = await provision.createAccount({ username: 'alice', displayName: 'Alice Author', password: 'Alice authorship password' });
  const bob = await provision.createAccount({ username: 'bob', displayName: 'Bob Editor', password: 'Bob authorship password' });
  const carol = await provision.createAccount({ username: 'carol', displayName: 'Carol Reader', password: 'Carol authorship password' });
  const app = createApp({ store, seed: false, authMode: 'password', basePath });
  const tokens = { alice: app.auth.createToken(alice.id, { name: 'Alice', scopes: ['read', 'write'] }), bob: app.auth.createToken(bob.id, { name: 'Bob', scopes: ['read', 'write'] }), reader: app.auth.createToken(carol.id, { name: 'Reader', scopes: ['read'] }), write: app.auth.createToken(carol.id, { name: 'Write', scopes: ['write'] }) };
  const actor: ActorAttribution = { principalId: alice.id, displayName: alice.displayName, credentialId: tokens.alice.record.id, requestId: 'initial-authorship' };
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}${basePath.replace(/\/$/, '')}`;
  async function request<T = ErrorBody>(path: string, method = 'GET', body?: unknown, who: keyof typeof tokens = 'alice', key?: string) {
    const response = await fetch(origin + path, { method, headers: { Authorization: `Bearer ${tokens[who].token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as T, headers: response.headers };
  }
  const path = (id: string) => `/api/revisions/${id}/authorship`;
  const revision = (kind: 'code' | 'paper' | 'document' = 'code', extra = {}) => store.createRevision({ testPlan: 'Fixture verification plan.', title: 'Original title', summary: 'Original summary', kind, files: [{ path: 'source.txt', content: 'Exact immutable source\n' }], ...extra }, actor);
  const input = (id: string, authorId = bob.id, action: 'assign' | 'commandeer' = 'assign'): RevisionAuthorInput => {
    const snapshot = store.revisionAuthorship.snapshot(id);
    return { action, ...(action === 'assign' ? { authorId } : {}), expectedAuthorVersion: snapshot.authorship.version, expectedReviewerVersion: snapshot.reviewerVersion, expectedLifecycleVersion: snapshot.lifecycleVersion, expectedVersion: snapshot.head.number, expectedVersionId: snapshot.head.versionId, expectedContentHash: snapshot.head.contentHash, expectedAccessEpoch: app.policies.epoch(), message: '  Exact handoff message\n' } as RevisionAuthorInput;
  };
  const policy = (id: string, rules: Record<string, unknown>, who = alice.id) => { const current = app.policies.policy(id, who); return app.policies.setPolicy(id, { expectedVersion: current.version, spaceId: current.spaceId, ...current.rules, ...rules }, who); };
  const evidence = () => Object.fromEntries(['entities', 'versions', 'reviews', 'comments', 'review_threads', 'thread_events', 'suggestion_applications'].map(table => [table, store.database.prepare(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all()]));
  return { ...app, alice, bob, carol, tokens, actor, request, revision, input, path, policy, evidence, close: async () => { await app.close(); store.close(); } };
}

for (const basePath of ['/', '/mounted/']) test(`authorship is mutable metadata with immutable author history and unchanged accepted source at ${basePath}`, async () => {
  const app = await start(basePath);
  try {
    for (const kind of ['code', 'paper', 'document'] as const) {
      const detail = app.revision(kind), id = detail.revision.id;
      app.store.saveReview(id, 1, { provider: 'local', model: 'test-check', summary: 'Recorded check', findings: [] }, app.actor);
      lifecycleAction(app.store, id, 'accept_reviewed', app.actor);
      const before = app.evidence(), epoch = app.policies.epoch(), original = await app.request<RevisionAuthorshipSnapshot>(app.path(id), 'GET', undefined, 'reader');
      assert.equal(original.status, 200); assert.equal(original.headers.get('cache-control'), 'no-store'); assert.equal(original.body.authorship.author?.principalId, app.alice.id);
      const data = app.input(id), saved = await app.request<RevisionAuthorReceipt>(app.path(id), 'POST', data, 'alice', `assign-${id}`);
      assert.equal(saved.status, 200, JSON.stringify(saved.body)); assert.equal(saved.body.transaction.author.principalId, app.bob.id); assert.equal(saved.body.transaction.message, data.message); assert.equal(saved.body.inputSha256, revisionAuthorInputHash(data)); assert.equal(app.policies.epoch(), epoch + 1); assert.deepEqual(app.evidence(), before);
      const commandeer = await app.request<RevisionAuthorReceipt>(app.path(id), 'POST', app.input(id, app.alice.id, 'commandeer'), 'alice', `claim-${id}`); assert.equal(commandeer.status, 200); assert.equal(commandeer.body.transaction.previousAuthor?.principalId, app.bob.id);
      const current = await app.request<RevisionAuthorshipSnapshot>(app.path(id)); assert.equal(current.body.authorship.version, 2); assert.equal(current.body.authorship.originalAuthor?.principalId, app.alice.id); assert.equal(current.body.status, 'accepted');
      const history = await app.request<RevisionAuthorHistory>(`${app.path(id)}/history?limit=1&expectedAuthorVersion=2`); assert.equal(history.body.transactions.length, 1); assert.equal(history.body.nextBefore, 2);
      const older = await app.request<RevisionAuthorHistory>(`${app.path(id)}/history?before=2&limit=1&expectedAuthorVersion=2`); assert.equal(older.body.transactions[0]!.authorVersion, 1); assert.equal(older.body.nextBefore, null);
      assert.equal((await app.request(`${app.path(id)}/history?expectedAuthorVersion=1`)).status, 409);
      const replay = await app.request<RevisionAuthorReceipt>(app.path(id), 'POST', data, 'alice', `assign-${id}`); assert.equal(replay.status, 200); assert.deepEqual(replay.body.transaction, saved.body.transaction); assert.equal(replay.body.accessEpoch, app.policies.epoch());
      assert.deepEqual(app.evidence(), before);
    }
  } finally { await app.close(); }
});

test('revision author grants view and edit but not interaction, and source authority plus write scope guard mutations', async () => {
  const app = await start();
  try {
    const id = app.revision().revision.id;
    app.policy(id, { view: members(app.bob.id, app.carol.id), edit: members(app.bob.id), interact: members() });
    const view = await app.request<RevisionAuthorshipSnapshot>(app.path(id)); assert.equal(view.status, 200); assert.deepEqual(view.body.access.capabilities, { view: true, edit: true, interact: false, managePolicy: true }); assert.equal(view.body.access.automatic?.kind, 'revision-author'); assert.doesNotMatch(view.body.access.interactLabel, /author/);
    assert.equal((await app.request(`/api/revisions/${id}/comments`, 'POST', { body: 'Denied', versionId: view.body.head.versionId }, 'alice', 'comment')).status, 403);
    const paste = app.store.pastes.create({ title: 'Paste author stays distinct', content: 'Private paste', language: null }, app.actor);
    app.policy(paste.id, { view: members(), edit: members(), interact: members() });
    const pasteAccess = app.policies.describe(paste.id, app.alice.id); assert.equal(pasteAccess.automatic?.kind, 'paste-author'); assert.equal(pasteAccess.capabilities.interact, true); assert.match(pasteAccess.interactLabel, /paste author/); assert.doesNotMatch(pasteAccess.editLabel, /revision author/);
    assert.equal((await app.request(app.path(id), 'POST', app.input(id), 'reader', 'read-token')).status, 403);
    assert.equal((await app.request(app.path(id), 'GET', undefined, 'write')).status, 403);
    assert.equal((await app.request(app.path(id), 'POST', app.input(id), 'write', 'no-edit')).status, 403);
    assert.equal((await app.request(app.path(id), 'POST', app.input(id))).status, 400);
    assert.equal((await app.request(app.path(id), 'POST', { ...app.input(id), authorId: 'missing-user' }, 'alice', 'missing')).status, 400);
    assert.equal((await app.request(app.path(id), 'POST', { ...app.input(id), action: 'commandeer' }, 'bob', 'extra-author')).status, 400);
    for (const query of ['?unexpected=1', '?expectedAuthorVersion=0', '/history?limit=0', '/history?limit=101', '/history?limit=1&limit=2', '/history?before=1&secret=x']) assert.equal((await app.request(app.path(id) + query)).status, 400, query);
  } finally { await app.close(); }
});

test('self handoff losing view has exact recoverable minimal receipt across later changes and credential rotation', async () => {
  const app = await start();
  try {
    const id = app.revision().revision.id; app.policy(id, { view: members(), edit: members(), interact: members() });
    const data = app.input(id), first = await app.request<RevisionAuthorResult>(app.path(id), 'POST', data, 'alice', 'self-handoff');
    assert.equal(first.status, 200); assert.ok('accessLost' in first.body); assert.deepEqual(Object.keys(first.body).sort(), ['accessEpoch', 'accessLost', 'inputSha256', 'operationId', 'revisionId', 'saved']); assert.equal(first.body.inputSha256, revisionAuthorInputHash(data));
    assert.equal((await app.request(app.path(id))).status, 404); assert.equal((await app.request(app.path(id), 'GET', undefined, 'bob')).status, 200);
    app.store.createVersion(id, { expectedVersion: 1, files: [{ path: 'source.txt', content: 'Private newer source' }], message: 'Later' });
    const originalCredential = app.tokens.alice.record.id; app.tokens.alice = app.auth.createToken(app.alice.id, { name: 'Rotated', scopes: ['read', 'write'] }); app.auth.revokeToken(app.alice.id, originalCredential);
    const retry = await app.request<RevisionAuthorResult>(app.path(id), 'POST', data, 'alice', 'self-handoff'); assert.deepEqual(retry.body, first.body);
    assert.equal((await app.request(app.path(id), 'POST', { ...data, message: 'Changed intent' }, 'alice', 'self-handoff')).status, 409);
    assert.equal((await app.request(app.path(id), 'POST', data, 'alice', 'new-unproven-key')).status, 404);
    app.auth.revokeToken(app.alice.id, app.tokens.alice.record.id); assert.equal((await app.request(app.path(id), 'POST', data, 'alice', 'self-handoff')).status, 401);
  } finally { await app.close(); }
});

test('handoff losing only edit acknowledges minimally; an ordinary editor does not acquire lost-access replay authority', async () => {
  const app = await start();
  try {
    const own = app.revision().revision.id; app.policy(own, { view: workspace, edit: members(), interact: members() });
    const saved = await app.request<RevisionAuthorResult>(app.path(own), 'POST', app.input(own), 'alice', 'lose-edit'); assert.equal(saved.status, 200); assert.ok('accessLost' in saved.body); assert.equal((await app.request(app.path(own))).status, 200);
    const other = app.revision().revision.id, data = app.input(other, app.carol.id);
    const normal = await app.request<RevisionAuthorReceipt>(app.path(other), 'POST', data, 'bob', 'editor-handoff'); assert.equal(normal.status, 200);
    app.policy(other, { view: members(app.carol.id), edit: members(app.carol.id), interact: members() }, app.carol.id);
    assert.equal((await app.request(app.path(other), 'POST', data, 'bob', 'editor-handoff')).status, 404);
  } finally { await app.close(); }
});

test('fresh exact pins and principal validation are atomic; historical replay does not require the former recipient still active', async () => {
  const app = await start();
  try {
    const id = app.revision().revision.id; closeRevision(app.store, id, app.actor); const original = app.input(id), before = app.evidence();
    for (const patch of [{ expectedAuthorVersion: 1 }, { expectedVersion: 2 }, { expectedVersionId: 'other' }, { expectedContentHash: 'f'.repeat(64) }, { expectedAccessEpoch: original.expectedAccessEpoch + 1 }, { authorId: app.alice.id }]) assert.equal((await app.request(app.path(id), 'POST', { ...original, ...patch }, 'alice', `bad-pin-${Object.keys(patch)[0]}`)).status, 409);
    assert.deepEqual(app.evidence(), before); assert.equal(app.store.revisionAuthorship.state(id).version, 0);
    const saved = await app.request<RevisionAuthorReceipt>(app.path(id), 'POST', original, 'alice', 'historical'); assert.equal(saved.status, 200);
    app.auth.setAccountDisabled(app.bob.id, true);
    assert.equal((await app.request(app.path(id), 'POST', original, 'alice', 'historical')).status, 200);
    assert.equal((await app.request(app.path(id), 'POST', app.input(id), 'alice', 'disabled-recipient')).status, 400);
    assert.equal((await app.request(app.path(id), 'POST', app.input(id, app.alice.id, 'commandeer'), 'alice', 'closed-claim')).status, 409);
    assert.equal((await app.request(app.path(id), 'POST', app.input(id, app.carol.id), 'alice', 'closed-transfer')).status, 200);
  } finally { await app.close(); }
});

test('close-on-accept is exposed and prevents commandeering accepted revisions while retaining explicit transfers and abandoned claims', async () => {
  const app = await start('/', true);
  try {
    const id = app.revision().revision.id;
    const oldClaim = app.input(id, app.bob.id, 'commandeer');
    const claim = await app.request<RevisionAuthorReceipt>(app.path(id), 'POST', oldClaim, 'bob', 'before-accept'); assert.equal(claim.status, 200);
    app.store.saveReview(id, 1, { provider: 'local', model: 'fixture', summary: 'Recorded evidence', findings: [] }, app.actor);
    lifecycleAction(app.store, id, 'accept_reviewed', app.actor);
    const read = await app.request<RevisionAuthorshipSnapshot>(app.path(id)); assert.equal(read.body.closeOnAccept, true); assert.equal(read.body.status, 'accepted');
    const before = app.store.revisionAuthorship.history(id);
    const denied = await app.request(app.path(id), 'POST', app.input(id, app.alice.id, 'commandeer'), 'alice', 'accepted-claim');
    assert.equal(denied.status, 409); assert.equal(denied.body.code, 'REVISION_AUTHOR_CLOSED'); assert.deepEqual(app.store.revisionAuthorship.history(id), before);
    const replay = await app.request<RevisionAuthorReceipt>(app.path(id), 'POST', oldClaim, 'bob', 'before-accept'); assert.equal(replay.status, 200); assert.deepEqual(replay.body.transaction, claim.body.transaction);
    assert.equal((await app.request(app.path(id), 'POST', app.input(id, app.carol.id), 'alice', 'accepted-transfer')).status, 200);
    const abandoned = app.revision().revision.id; lifecycleAction(app.store, abandoned, 'abandon', app.actor);
    assert.equal((await app.request(app.path(abandoned), 'POST', app.input(abandoned, app.bob.id, 'commandeer'), 'bob', 'abandoned-claim')).status, 200);
  } finally { await app.close(); }
});

test('saved receipts cannot borrow another canonical operation or smuggle a hidden operation id', async () => {
  const app = await start();
  try {
    const one = app.revision().revision.id, two = app.revision().revision.id;
    const a = app.input(one);
    const first = await app.request<RevisionAuthorReceipt>(app.path(one), 'POST', a, 'alice', 'receipt-a');
    const second = await app.request<RevisionAuthorReceipt>(app.path(two), 'POST', app.input(two), 'alice', 'receipt-b'); assert.equal(first.status, 200); assert.equal(second.status, 200);
    app.policy(two, { view: members(app.bob.id), edit: members(app.bob.id), interact: members() }, app.bob.id);
    const row = app.store.database.prepare("SELECT key,body FROM idempotency WHERE key LIKE '%:receipt-a'").get() as { key: string; body: string };
    for (const forged of [second.body, { ...first.body, operationId: second.body.operationId }, { ...first.body, inputSha256: 'f'.repeat(64) }, { ...first.body, transaction: { ...first.body.transaction, message: 'forged' } }]) {
      app.store.database.prepare('UPDATE idempotency SET body=? WHERE key=?').run(JSON.stringify(forged), row.key);
      const result = await app.request(app.path(one), 'POST', a, 'alice', 'receipt-a'); assert.equal(result.status, 409); assert.equal(result.body.code, 'REVISION_AUTHOR_INVALID_RECEIPT');
    }
    app.store.database.prepare('UPDATE idempotency SET body=? WHERE key=?').run(row.body, row.key); assert.equal((await app.request(app.path(one), 'POST', a, 'alice', 'receipt-a')).status, 200);
  } finally { await app.close(); }
});

test('automatic author view and edit remain bounded by revision Space and linked repository', async () => {
  const app = await start();
  try {
    const repository = app.store.createRepository({ name: 'Private source', remoteUrl: 'https://example.test/repository.git', description: '', defaultBranch: 'main' });
    const id = app.revision('code', { repositoryId: repository.id }).revision.id;
    app.policy(repository.id, { view: members(app.alice.id), edit: members(app.alice.id), interact: members(app.alice.id) });
    const saved = await app.request(app.path(id), 'POST', app.input(id), 'alice', 'invisible-recipient'); assert.equal(saved.status, 200);
    assert.equal((await app.request(app.path(id), 'GET', undefined, 'bob')).status, 404); assert.equal((await app.request(`${app.path(id)}/history`, 'GET', undefined, 'bob')).status, 404);
    app.policy(repository.id, { view: workspace, edit: workspace, interact: workspace }); assert.equal((await app.request(app.path(id), 'GET', undefined, 'bob')).status, 200);
    const space = app.policies.createSpace({ name: 'Alice only', view: members(app.alice.id), edit: members(app.alice.id) }, app.alice.id);
    app.policy(id, { spaceId: space.id }); assert.equal((await app.request(app.path(id), 'GET', undefined, 'bob')).status, 404);
    assert.equal((await app.request(app.path(id), 'POST', app.input(id, app.bob.id, 'commandeer'), 'bob', 'denied-source')).status, 404);
  } finally { await app.close(); }
});


test('historical source File Space remains a ceiling for the new author even after the figure is removed', async () => {
  const app = await start();
  try {
    const bytes = Buffer.from('%PDF-1.4\nPrivate historical figure');
    const file = app.store.files.upload({ name: 'figure.pdf', dataBase64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }, app.actor); registerFilePolicy(app.store.database, file.id, app.alice.id);
    const detail = app.revision('paper', { assets: [{ path: 'figure.pdf', fileId: file.id, sha256: file.sha256, bytes: file.bytes, mediaType: 'application/pdf' }], shareAssets: true }), id = detail.revision.id;
    app.store.createVersion(id, { expectedVersion: 1, expectedVersionId: detail.versions[0]!.id, expectedContentHash: detail.versions[0]!.contentHash, files: [{ path: 'source.txt', content: 'Removed current figure' }], assets: [], message: 'Keep history' }, app.actor);
    assert.equal((await app.request(app.path(id), 'POST', app.input(id), 'alice', 'figure-author')).status, 200);
    assert.equal((await app.request(app.path(id), 'GET', undefined, 'bob')).status, 200);
    const space = app.policies.createSpace({ name: 'Historical File', view: members(app.alice.id), edit: members(app.alice.id) }, app.alice.id); app.policy(file.id, { spaceId: space.id });
    for (const suffix of ['', '/history']) assert.equal((await app.request(app.path(id) + suffix, 'GET', undefined, 'bob')).status, 404);
    assert.equal((await app.request(`/api/revisions/${id}`, 'GET', undefined, 'bob')).status, 404);
    assert.equal((await app.request(app.path(id), 'POST', app.input(id, app.carol.id), 'bob', 'file-denied-write')).status, 404);
    assert.equal(app.store.revisionAuthorship.state(id).author?.principalId, app.bob.id, 'denial does not rewrite the author');
  } finally { await app.close(); }
});
