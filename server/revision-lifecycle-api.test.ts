import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { AddressInfo } from 'node:net';
import { createApp } from './app.ts';
import { createAuth } from './auth.ts';
import { Store } from './store.ts';
import type { ActorAttribution } from '../shared/types.ts';
import type { RevisionLifecycleAction, RevisionLifecycleConfig, RevisionLifecycleInput, RevisionLifecycleSnapshot, RevisionLifecycleReceipt, RevisionLifecycleHistory } from '../shared/revision-lifecycle.ts';
import { revisionLifecycleInputHash } from './revision-lifecycle.ts';
import { registerFilePolicy } from './policy.ts';

const members = (...principalIds: string[]) => ({ kind: 'principals' as const, principalIds });
const workspace = { kind: 'workspace' as const };
type ErrorBody = { error: string; code?: string };
async function start(basePath = '/', configuration: Partial<RevisionLifecycleConfig> = {}, databasePath = ':memory:') {
  const store = new Store({ path: databasePath, revisionLifecycle: { allowReopen: false, alwaysAllowClose: false, alwaysAllowAbandon: false, closeOnAccept: false, ...configuration } });
  const provision = createAuth({ database: store.database, mode: 'local', basePath: '/', provisioning: true });
  const alice = await provision.createAccount({ username: 'alice', displayName: 'Alice Author', password: 'Alice lifecycle long password' });
  const bob = await provision.createAccount({ username: 'bob', displayName: 'Bob Editor', password: 'Bob lifecycle long password' });
  const app = createApp({ store, seed: false, authMode: 'password', basePath });
  const tokens = { alice: app.auth.createToken(alice.id, { name: 'Alice', scopes: ['read', 'write'] }), bob: app.auth.createToken(bob.id, { name: 'Bob', scopes: ['read', 'write'] }), reader: app.auth.createToken(bob.id, { name: 'Reader', scopes: ['read'] }), write: app.auth.createToken(bob.id, { name: 'Write only', scopes: ['write'] }) };
  const actor: ActorAttribution = { principalId: alice.id, displayName: alice.displayName, credentialId: tokens.alice.record.id, requestId: 'initial-lifecycle' };
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}${basePath.replace(/\/$/, '')}`;
  async function request<T = ErrorBody>(path: string, method = 'GET', body?: unknown, who: keyof typeof tokens = 'alice', key?: string) {
    const response = await fetch(origin + path, { method, headers: { Authorization: `Bearer ${tokens[who].token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as T, headers: response.headers };
  }
  const path = (id: string) => `/api/revisions/${id}/lifecycle`;
  const revision = (kind: 'code' | 'paper' | 'document' = 'code', extra = {}) => store.createRevision({ title: 'Original title', summary: 'Original summary', kind, files: [{ path: 'source.txt', content: 'Exact immutable source\n' }], ...extra }, actor);
  const input = (id: string, action: RevisionLifecycleAction): RevisionLifecycleInput => {
    const snapshot = store.revisionLifecycle.snapshot(id, alice.id);
    return { action, expectedLifecycleVersion: snapshot.lifecycle.version, expectedReviewerVersion: snapshot.reviewers.version, expectedAuthorVersion: snapshot.authorship.version, expectedVersion: snapshot.head.number, expectedVersionId: snapshot.head.versionId, expectedContentHash: snapshot.head.contentHash, expectedAccessEpoch: app.policies.epoch(), expectedConfigId: snapshot.configId, expectedEvidenceSha256: snapshot.evidence.sha256, message: '  Exact action message\n' };
  };
  const policy = (id: string, rules: Record<string, unknown>, who = alice.id) => { const current = app.policies.policy(id, who); return app.policies.setPolicy(id, { expectedVersion: current.version, spaceId: current.spaceId, ...current.rules, ...rules }, who); };
  const evidence = (id: string, error = false) => store.saveReview(id, store.detail(id).revision.currentVersion, { provider: 'local', model: 'test-check', summary: 'Recorded check', findings: error ? [{ id: 'error', source: 'local', severity: 'error', filePath: 'source.txt', line: 1, title: 'Blocking finding', body: 'A recorded exact-source problem.' }] : [] }, actor);
  const act = async (id: string, action: RevisionLifecycleAction, who: keyof typeof tokens = 'alice', key: string = crypto.randomUUID()) => { const data = input(id, action), response = await request<RevisionLifecycleReceipt>(path(id), 'POST', data, who, key); assert.equal(response.status, 200, JSON.stringify(response.body)); return { data, key, receipt: response.body }; };
  return { ...app, alice, bob, tokens, actor, origin, request, revision, input, path, policy, evidence, act, close: async () => { await app.close(); store.close(); } };
}

for (const basePath of ['/', '/mounted/']) test(`explicit lifecycle actions preserve source and page immutable exact receipts at ${basePath}`, async () => {
  const app = await start(basePath, { allowReopen: true });
  try {
    for (const kind of ['code', 'paper', 'document'] as const) {
      const detail = app.revision(kind), id = detail.revision.id;
      const initial = await app.request<RevisionLifecycleSnapshot>(app.path(id), 'GET', undefined, 'reader'); assert.equal(initial.status, 200); assert.equal(initial.headers.get('cache-control'), 'no-store');
      const planned = await app.act(id, 'plan_changes'); assert.equal(planned.receipt.transaction.toStatus, 'changes_planned'); assert.equal(planned.receipt.inputSha256, revisionLifecycleInputHash(planned.data));
      await app.act(id, 'request_review'); app.evidence(id); await app.act(id, 'accept_reviewed'); await app.act(id, 'close');
      const reopened = await app.act(id, 'reopen', 'bob'); assert.equal(reopened.receipt.transaction.toStatus, 'accepted', 'a non-author editor can reopen and restore retained exact-source acceptance');
      await app.act(id, 'abandon'); await app.act(id, 'reclaim');
      const current = (await app.request<RevisionLifecycleSnapshot>(app.path(id))).body;
      assert.equal(current.lifecycle.status, 'accepted', 'reclaim reassesses retained exact-source acceptance'); assert.deepEqual(app.store.detail(id).versions, detail.versions);
      const first = await app.request<RevisionLifecycleHistory>(`${app.path(id)}/history?limit=1&expectedLifecycleVersion=${current.lifecycle.version}`); assert.equal(first.status, 200); assert.equal(first.body.transactions.length, 1); assert.ok(first.body.nextBefore);
      const older = await app.request<RevisionLifecycleHistory>(`${app.path(id)}/history?limit=1&before=${first.body.nextBefore}&expectedLifecycleVersion=${current.lifecycle.version}`); assert.equal(older.status, 200); assert.ok(older.body.transactions[0]!.lifecycleVersion < first.body.transactions[0]!.lifecycleVersion);
      const replay = await app.request<RevisionLifecycleReceipt>(app.path(id), 'POST', planned.data, 'alice', planned.key); assert.equal(replay.status, 200); assert.deepEqual(replay.body.transaction, planned.receipt.transaction); assert.equal(replay.body.accessEpoch, app.policies.epoch());
      assert.equal((await app.request(`${app.path(id)}/history?expectedLifecycleVersion=0`)).status, 409);
      app.store.createVersion(id, { expectedVersion: 1, files: [{ path: 'source.txt', content: 'Changed immutable source\n' }], message: 'Acceptance must remain bound to its original source.' }, app.actor);
      const changed = (await app.request<RevisionLifecycleSnapshot>(app.path(id))).body;
      assert.equal(changed.lifecycle.status, 'needs_review'); assert.equal(changed.reviewers.acceptance, null);
      assert.equal(changed.head.number, 2); assert.notEqual(changed.head.contentHash, current.head.contentHash);
    }
  } finally { await app.close(); }
});

test('current edit and write authority guard actions; author interaction is not an implicit requirement', async () => {
  const app = await start();
  try {
    const id = app.revision().revision.id; app.policy(id, { view: workspace, edit: members(app.alice.id), interact: members() });
    const data = app.input(id, 'plan_changes');
    assert.equal((await app.request(app.path(id), 'POST', data, 'reader', 'read-only')).status, 403);
    assert.equal((await app.request(app.path(id), 'POST', data, 'bob', 'no-edit')).status, 403);
    assert.equal((await app.request(app.path(id), 'GET', undefined, 'write')).status, 403);
    const reader = (await app.request<RevisionLifecycleSnapshot>(app.path(id), 'GET', undefined, 'bob')).body; assert.ok(reader.actions.every(action => !action.available));
    assert.equal((await app.request(app.path(id), 'POST', data)).status, 400);
    assert.equal((await app.request(app.path(id), 'POST', { ...data, authorId: app.bob.id }, 'alice', 'extra')).status, 400);
    await app.act(id, 'plan_changes');
    for (const query of ['?x=1', '/history?limit=0', '/history?limit=101', '/history?limit=1&limit=2', '/history?before=-1', '/history?expectedLifecycleVersion=1.5']) assert.equal((await app.request(app.path(id) + query)).status, 400, query);
    const foreign = app.revision().revision.id; assert.equal((await app.request(app.path(foreign), 'POST', app.input(foreign, 'abandon'), 'bob', 'not-author')).status, 409);
    const draft = app.revision('document', { draft: true }).revision.id; await app.act(draft, 'request_review', 'bob');
  } finally { await app.close(); }
});

test('all decision pins detect source, author, status, access, configuration and uninspected evidence changes', async () => {
  const app = await start();
  try {
    const id = app.revision().revision.id, original = app.input(id, 'plan_changes');
    for (const patch of [{ expectedLifecycleVersion: 99 }, { expectedAuthorVersion: 99 }, { expectedVersion: 2 }, { expectedVersionId: 'other-head' }, { expectedContentHash: 'f'.repeat(64) }, { expectedAccessEpoch: original.expectedAccessEpoch + 1 }, { expectedConfigId: 'e'.repeat(64) }, { expectedEvidenceSha256: 'a'.repeat(64) }]) assert.equal((await app.request(app.path(id), 'POST', { ...original, ...patch }, 'alice', crypto.randomUUID())).status, 409, JSON.stringify(patch));
    app.evidence(id); assert.equal((await app.request(app.path(id), 'POST', original, 'alice', 'late-evidence')).status, 409);
    const data = app.input(id, 'plan_changes'); const race = await Promise.all(['race-a', 'race-b'].map(key => app.request(app.path(id), 'POST', data, 'alice', key))); assert.deepEqual(race.map(row => row.status).sort(), [200, 409]);
    const winner = race[0]!.status === 200 ? 'race-a' : 'race-b'; assert.equal((await app.request(app.path(id), 'POST', { ...data, message: 'Other action' }, 'alice', winner)).status, 409);
  } finally { await app.close(); }
});

test('historical retries preserve original attribution after handoff and credential rotation but cannot disclose after view or edit loss', async () => {
  const app = await start();
  try {
    const id = app.revision().revision.id, saved = await app.act(id, 'plan_changes');
    const author = app.store.revisionAuthorship.snapshot(id); app.store.revisionAuthorship.mutate(id, { action: 'assign', authorId: app.bob.id, expectedAuthorVersion: author.authorship.version, expectedReviewerVersion: author.reviewerVersion, expectedLifecycleVersion: author.lifecycleVersion, expectedVersion: author.head.number, expectedVersionId: author.head.versionId, expectedContentHash: author.head.contentHash, expectedAccessEpoch: app.policies.epoch(), message: 'Handoff' }, app.actor, { principalId: app.bob.id, displayName: app.bob.displayName });
    const old = app.tokens.alice.record.id; app.tokens.alice = app.auth.createToken(app.alice.id, { name: 'Rotated', scopes: ['read', 'write'] }); app.auth.revokeToken(app.alice.id, old);
    const replay = await app.request<RevisionLifecycleReceipt>(app.path(id), 'POST', saved.data, 'alice', saved.key); assert.equal(replay.status, 200); assert.deepEqual(replay.body.transaction, saved.receipt.transaction); assert.equal(replay.body.accessEpoch, app.policies.epoch());
    app.policy(id, { edit: members(app.bob.id) }, app.bob.id); assert.equal((await app.request(app.path(id), 'POST', saved.data, 'alice', saved.key)).status, 403);
    app.policy(id, { view: members(app.bob.id), interact: members(app.bob.id) }, app.bob.id);
    const hidden = await app.request(app.path(id), 'POST', saved.data, 'alice', saved.key); assert.equal(hidden.status, 404); assert.deepEqual(hidden.body, (await app.request('/api/revisions/D999999/lifecycle', 'POST', saved.data, 'alice', saved.key)).body);
    app.auth.revokeToken(app.alice.id, app.tokens.alice.record.id); assert.equal((await app.request(app.path(id), 'POST', saved.data, 'alice', saved.key)).status, 401);
  } finally { await app.close(); }
});

test('saved lifecycle responses are bound to immutable operation owner, exact input and authenticated principal', async () => {
  const app = await start();
  try {
    const id = app.revision().revision.id, saved = await app.act(id, 'plan_changes', 'alice', 'protected-action');
    const row = app.store.database.prepare('SELECT key,body FROM idempotency WHERE key LIKE ?').get('%:protected-action') as { key: string; body: string };
    const other = app.store.createRevision({ title: 'Hidden foreign source', kind: 'code', files: [{ path: 'private.txt', content: 'Never disclose this source' }] }, { ...app.actor, principalId: app.bob.id, displayName: app.bob.displayName }).revision.id;
    const foreign = await app.act(other, 'plan_changes', 'bob'); app.policy(other, { view: members(app.bob.id), edit: members(app.bob.id) }, app.bob.id);
    assert.equal((await app.request(app.path(other))).status, 404);
    const operation = app.store.revisionLifecycle.operation.bind(app.store.revisionLifecycle);
    let hiddenLoads = 0;
    app.store.revisionLifecycle.operation = operationId => { if (operationId === foreign.receipt.operationId) { hiddenLoads++; throw new Error('Hidden operation must not load'); } return operation(operationId); };
    for (const body of [{ ...saved.receipt, inputSha256: 'f'.repeat(64) }, { ...saved.receipt, transaction: { ...saved.receipt.transaction, message: 'Forged evidence' } }, foreign.receipt, { ...saved.receipt, operationId: foreign.receipt.operationId }]) {
      app.store.database.prepare('UPDATE idempotency SET body=? WHERE key=?').run(JSON.stringify(body), row.key);
      assert.equal((await app.request(app.path(id), 'POST', saved.data, 'alice', saved.key)).status, 409);
    }
    assert.equal(hiddenLoads, 0, 'hidden operation evidence must not be loaded before checking its owner');
    app.store.database.prepare('UPDATE idempotency SET body=? WHERE key=?').run(row.body, row.key); assert.equal((await app.request(app.path(id), 'POST', saved.data, 'alice', saved.key)).status, 200);
  } finally { await app.close(); }
});

test('free-form status changes and unprovable legacy retries fail safely without rewriting old records', async () => {
  const app = await start();
  try {
    const id = app.revision().revision.id, path = `/api/revisions/${id}`, body = { status: 'closed', expectedVersion: 1 };
    const first = await app.request(path, 'PATCH', body, 'alice', 'new-status'); assert.equal(first.status, 409); assert.equal(first.body.code, 'REVISION_LIFECYCLE_ACTION_REQUIRED');
    const context = `${app.auth.workspaceId}:${app.alice.id}:legacy-status`, raw = JSON.stringify({ ...app.store.detail(id).revision, status: 'closed' });
    app.store.database.prepare('INSERT INTO idempotency(key,fingerprint,status,body,created_at) VALUES(?,?,?,?,?)').run(context, 'historical-fingerprint', 200, raw, '2026-01-01T00:00:00Z');
    const before = app.store.database.prepare('SELECT rowid,* FROM idempotency WHERE key=?').get(context);
    const retry = await app.request(path, 'PATCH', body, 'alice', 'legacy-status'); assert.equal(retry.status, 409); assert.equal(retry.body.code, 'REVISION_LIFECYCLE_LEGACY_RECEIPT');
    assert.deepEqual(app.store.database.prepare('SELECT rowid,* FROM idempotency WHERE key=?').get(context), before); assert.equal(app.store.detail(id).revision.status, 'needs_review');
  } finally { await app.close(); }
});

test('revision, repository and historical File Space ceilings protect lifecycle snapshots, history and saved receipts', async () => {
  const app = await start();
  try {
    for (const ceiling of ['revision', 'repository', 'historical-file'] as const) {
      let subject: string; let id: string;
      if (ceiling === 'repository') {
        const repository = app.store.createRepository({ name: 'Restricted source', remoteUrl: 'https://example.test/source.git', description: '', defaultBranch: 'main' });
        id = app.revision('code', { repositoryId: repository.id }).revision.id; subject = repository.id;
      } else if (ceiling === 'historical-file') {
        const bytes = Buffer.from('%PDF-1.4\nHistorical figure');
        const file = app.store.files.upload({ name: 'figure.pdf', dataBase64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }, app.actor); registerFilePolicy(app.store.database, file.id, app.alice.id);
        const detail = app.revision('paper', { assets: [{ path: 'figure.pdf', fileId: file.id, sha256: file.sha256, bytes: file.bytes, mediaType: 'application/pdf' }], shareAssets: true }); id = detail.revision.id; subject = file.id;
        app.store.createVersion(id, { expectedVersion: 1, expectedVersionId: detail.versions[0]!.id, expectedContentHash: detail.versions[0]!.contentHash, files: [{ path: 'source.txt', content: 'Figure removed from current source' }], assets: [], message: 'Keep immutable history' }, app.actor);
      } else { id = app.revision().revision.id; subject = id; }
      const saved = await app.act(id, 'plan_changes'), before = app.store.revisionLifecycle.history(id);
      app.policy(subject, { view: workspace, edit: workspace, interact: workspace });
      const space = app.policies.createSpace({ name: `Ceiling ${ceiling}`, view: members(app.bob.id), edit: members(app.bob.id) }, app.bob.id); app.policy(subject, { spaceId: space.id }, app.bob.id);
      for (const suffix of ['', '/history']) assert.equal((await app.request(app.path(id) + suffix)).status, 404, ceiling + suffix);
      assert.equal((await app.request(app.path(id), 'POST', saved.data, 'alice', saved.key)).status, 404);
      assert.equal((await app.request(app.path(id), 'POST', app.input(id, 'request_review'), 'alice', crypto.randomUUID())).status, 404);
      assert.deepEqual(app.store.revisionLifecycle.history(id), before); assert.equal(app.store.revisionAuthorship.state(id).author?.principalId, app.alice.id, 'ownership remains bounded by the source ceiling');
    }
  } finally { await app.close(); }
});

test('lifecycle actions and saved receipts recheck access after waiting for the SQLite writer', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'phab-lifecycle-lock-')), databasePath = join(directory, 'workspace.sqlite');
  const app = await start('/', {}, databasePath), transaction = app.store.transaction.bind(app.store);
  try {
    for (const phase of ['write', 'replay'] as const) {
      const id = app.store.createRevision({ title: 'Another author draft', kind: 'code', draft: true, files: [{ path: 'source.txt', content: 'Immutable body' }] }, { ...app.actor, principalId: app.bob.id, displayName: app.bob.displayName }).revision.id;
      const data = app.input(id, 'request_review'), key = `lifecycle-lock-${phase}`;
      let replay: { key: string; fingerprint: string; status: number; body: string; created_at: string } | undefined;
      if (phase === 'replay') {
        assert.equal((await app.request(app.path(id), 'POST', data, 'alice', key)).status, 200);
        replay = app.store.database.prepare('SELECT * FROM idempotency WHERE key LIKE ?').get(`%:${key}`) as typeof replay; assert.ok(replay);
        app.store.database.prepare('DELETE FROM idempotency WHERE key=?').run(replay.key);
      }
      const before = app.store.revisionLifecycle.history(id), original = app.policies.policy(id, app.alice.id);
      const policy = { ...original, version: original.version + 1, rules: { view: members(app.bob.id), edit: members(app.bob.id), interact: members(app.bob.id) } };
      const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(`
        import { parentPort, workerData } from 'node:worker_threads';
        import { DatabaseSync } from 'node:sqlite';
        const db = new DatabaseSync(workerData.databasePath); db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
        db.prepare('UPDATE object_policies SET data=? WHERE object_id=?').run(JSON.stringify(workerData.policy), workerData.policy.objectId);
        db.prepare("UPDATE policy_meta SET value=value+1 WHERE name='epoch'").run();
        if(workerData.replay) { const r=workerData.replay; db.prepare('INSERT INTO idempotency(key,fingerprint,status,body,created_at) VALUES(?,?,?,?,?)').run(r.key,r.fingerprint,r.status,r.body,r.created_at); }
        parentPort.once('message',()=>{ db.exec('COMMIT'); db.close(); parentPort.close(); }); parentPort.postMessage('locked');
      `)}`), { workerData: { databasePath, policy, replay } });
      try {
        assert.deepEqual(await once(worker, 'message'), ['locked']); let entered = 0;
        app.store.transaction = function<T>(work: () => T): T { entered++; app.store.transaction = transaction; worker.postMessage('commit'); return transaction(work); };
        const denied = await app.request(app.path(id), 'POST', data, 'alice', key); assert.equal(entered, 1); assert.equal(denied.status, 404); assert.equal(denied.body.code, 'OBJECT_UNAVAILABLE');
        assert.deepEqual(app.store.revisionLifecycle.history(id), before);
      } finally { app.store.transaction = transaction; await worker.terminate(); }
    }
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
