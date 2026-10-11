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
import { revisionReviewerInput, type RevisionReviewerInput, type RevisionReviewerSnapshot, type RevisionReviewerReceipt, type RevisionReviewerHistory } from '../shared/revision-reviewers.ts';
import { revisionReviewerInputHash } from './revision-reviewers.ts';

const members = (...principalIds: string[]) => ({ kind: 'principals' as const, principalIds }), workspace = { kind: 'workspace' as const };
type ErrorBody = { error: string; code?: string };
async function start(basePath = '/', allowSelfAccept = false, databasePath = ':memory:') {
  const store = new Store({ path: databasePath, revisionReviewers: { allowSelfAccept } });
  const provision = createAuth({ database: store.database, mode: 'local', basePath: '/', provisioning: true });
  const alice = await provision.createAccount({ username: 'alice', displayName: 'Alice Author', password: 'Alice reviewer API password long enough' });
  const bob = await provision.createAccount({ username: 'bob', displayName: 'Bob Editor', password: 'Bob reviewer API password long enough' });
  const carol = await provision.createAccount({ username: 'carol', displayName: 'Carol Reviewer', password: 'Carol reviewer API password long enough' });
  const app = createApp({ store, seed: false, authMode: 'password', basePath });
  const tokens = { alice: app.auth.createToken(alice.id, { name: 'Author', scopes: ['read', 'write'] }), bob: app.auth.createToken(bob.id, { name: 'Editor', scopes: ['read', 'write'] }), carol: app.auth.createToken(carol.id, { name: 'Reviewer', scopes: ['read', 'write'] }), reader: app.auth.createToken(carol.id, { name: 'Read only', scopes: ['read'] }) };
  const actor: ActorAttribution = { principalId: alice.id, displayName: alice.displayName, credentialId: tokens.alice.record.id, requestId: 'initial-reviewer-source' };
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}${basePath.replace(/\/$/, '')}`;
  async function request<T = ErrorBody>(path: string, method = 'GET', body?: unknown, who: keyof typeof tokens = 'alice', key?: string) {
    const response = await fetch(origin + path, { method, signal: AbortSignal.timeout(30_000), headers: { Authorization: `Bearer ${tokens[who].token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as T, headers: response.headers };
  }
  const path = (id: string) => `/api/revisions/${id}/reviewers`;
  const policy = (id: string, rules: Record<string, unknown>, who = alice.id) => { const current = app.policies.policy(id, who); return app.policies.setPolicy(id, { expectedVersion: current.version, spaceId: current.spaceId, ...current.rules, ...rules }, who); };
  const revision = (kind: 'code' | 'paper' | 'document' = 'code', extra = {}) => {
    const detail = store.createRevision({ title: 'Immutable review source', kind, files: [{ path: 'source.txt', content: 'Exact manuscript\n' }], ...extra }, actor);
    policy(detail.revision.id, { view: workspace, edit: members(alice.id, bob.id), interact: workspace }); return detail;
  };
  const input = (id: string, action: RevisionReviewerInput['action'], reviewerId?: string): RevisionReviewerInput => {
    const s = store.revisionReviewers.snapshot(id, carol.id);
    return revisionReviewerInput({ action, ...(reviewerId === undefined ? {} : { reviewerId }), message: '  Exact review message\n', expectedReviewerVersion: s.reviewers.version, expectedLifecycleVersion: s.lifecycle.version, expectedAuthorVersion: s.authorship.version, expectedVersion: s.head.number, expectedVersionId: s.head.versionId, expectedContentHash: s.head.contentHash, expectedAccessEpoch: app.policies.epoch(), expectedConfigId: s.configId, expectedEvidenceSha256: s.evidence.sha256 });
  };
  const act = async (id: string, action: RevisionReviewerInput['action'], who: keyof typeof tokens = 'carol', reviewerId?: string, key: string = crypto.randomUUID()) => { const data = input(id, action, reviewerId), response = await request<RevisionReviewerReceipt>(path(id), 'POST', data, who, key); assert.equal(response.status, 200, JSON.stringify(response.body)); return { data, key, receipt: response.body }; };
  return { ...app, alice, bob, carol, actor, tokens, origin, request, path, policy, revision, input, act, close: async () => { await app.close(); store.close(); } };
}

for (const basePath of ['/', '/mounted/']) test(`noneditor reviewer decisions are exact, immutable and distinct from machine evidence at ${basePath}`, async () => {
  const app = await start(basePath);
  try {
    for (const kind of ['code', 'paper', 'document'] as const) {
      const detail = app.revision(kind), id = detail.revision.id;
      const snapshot = await app.request<RevisionReviewerSnapshot>(app.path(id), 'GET', undefined, 'carol'); assert.equal(snapshot.status, 200); assert.equal(snapshot.headers.get('cache-control'), 'no-store'); assert.equal(snapshot.body.access.capabilities.edit, false); assert.equal(snapshot.body.access.capabilities.interact, true);
      const accepted = await app.act(id, 'accept'); assert.equal(accepted.receipt.inputSha256, revisionReviewerInputHash(accepted.data)); assert.equal(accepted.receipt.transaction.action, 'accept'); assert.equal(accepted.receipt.transaction.attribution?.principalId, app.carol.id); assert.equal(app.store.detail(id).revision.status, 'accepted');
      const changes = await app.act(id, 'request_changes'); assert.equal(changes.receipt.transaction.action, 'request_changes'); assert.equal(app.store.detail(id).revision.status, 'changes_requested');
      await app.act(id, 'resign');
      assert.deepEqual(app.store.detail(id).versions, detail.versions); assert.deepEqual(app.store.detail(id).reviews, []);
      const current = (await app.request<RevisionReviewerSnapshot>(app.path(id))).body;
      const page = await app.request<RevisionReviewerHistory>(`${app.path(id)}/history?limit=1&expectedReviewerVersion=${current.reviewers.version}`); assert.equal(page.status, 200); assert.equal(page.body.transactions.length, 1); assert.ok(page.body.nextBefore);
      const older = await app.request<RevisionReviewerHistory>(`${app.path(id)}/history?limit=1&before=${page.body.nextBefore}&expectedReviewerVersion=${current.reviewers.version}`); assert.equal(older.status, 200); assert.ok(older.body.transactions[0]!.reviewerVersion < page.body.transactions[0]!.reviewerVersion);
      const replay = await app.request<RevisionReviewerReceipt>(app.path(id), 'POST', accepted.data, 'carol', accepted.key); assert.equal(replay.status, 200); assert.deepEqual(replay.body.transaction, accepted.receipt.transaction);
      assert.equal((await app.request(`${app.path(id)}/history?expectedReviewerVersion=0`)).status, 409);
    }
  } finally { await app.close(); }
});

test('membership needs edit, decisions need interaction, and self acceptance is denied unless explicitly configured', async () => {
  const app = await start();
  try {
    const id = app.revision().revision.id, add = app.input(id, 'add', app.carol.id);
    assert.equal((await app.request(app.path(id), 'POST', add, 'carol', 'no-edit')).status, 403);
    assert.equal((await app.request(app.path(id), 'POST', app.input(id, 'accept'), 'reader', 'read-only')).status, 403);
    assert.equal((await app.request(app.path(id), 'POST', app.input(id, 'accept'), 'alice', 'self')).status, 409);
    await app.act(id, 'add', 'bob', app.carol.id);
    await app.act(id, 'block', 'bob', app.carol.id); await app.act(id, 'unblock', 'bob', app.carol.id);
    app.policy(id, { interact: members(app.alice.id) });
    const snapshot = (await app.request<RevisionReviewerSnapshot>(app.path(id), 'GET', undefined, 'carol')).body; assert.ok(snapshot.actions.filter(action => ['accept', 'request_changes', 'resign'].includes(action.action)).every(action => !action.available));
    assert.equal((await app.request(app.path(id), 'POST', app.input(id, 'accept'), 'carol', 'no-interact')).status, 403);
    await app.act(id, 'remove', 'bob', app.carol.id);
    await app.act(id, 'add', 'bob', app.carol.id); await app.act(id, 'block', 'bob', app.carol.id);
    app.auth.setAccountDisabled(app.carol.id, true); await app.act(id, 'unblock', 'bob', app.carol.id); await app.act(id, 'remove', 'bob', app.carol.id);
    assert.equal((await app.request(app.path(id), 'POST', app.input(id, 'add', app.carol.id), 'bob', 'disabled')).status, 400);
    assert.equal((await app.request(app.path(id), 'POST', app.input(id, 'add', 'missing-user'), 'bob', 'missing')).status, 400);
    assert.equal((await app.request(app.path(id), 'GET', undefined, 'bob')).status, 200, 'an unavailable target does not hide the source');
  } finally { await app.close(); }
  const enabled = await start('/', true);
  try { const id = enabled.revision().revision.id; await enabled.act(id, 'accept', 'alice'); assert.equal(enabled.store.detail(id).revision.status, 'accepted'); }
  finally { await enabled.close(); }
});

test('strict reviewer inputs and every decision pin reject ambiguity and concurrent changes atomically', async () => {
  const app = await start();
  try {
    const id = app.revision().revision.id, input = app.input(id, 'accept');
    for (const patch of [{ expectedReviewerVersion: 99 }, { expectedLifecycleVersion: 99 }, { expectedAuthorVersion: 99 }, { expectedVersion: 2 }, { expectedVersionId: 'other' }, { expectedContentHash: 'f'.repeat(64) }, { expectedAccessEpoch: input.expectedAccessEpoch + 1 }, { expectedConfigId: 'e'.repeat(64) }, { expectedEvidenceSha256: 'd'.repeat(64) }]) assert.equal((await app.request(app.path(id), 'POST', { ...input, ...patch }, 'carol', crypto.randomUUID())).status, 409, JSON.stringify(patch));
    for (const query of ['?extra=1', '/history?before=0', '/history?limit=101', '/history?limit=1&limit=2', '/history?expectedReviewerVersion=-1']) assert.equal((await app.request(app.path(id) + query)).status, 400);
    assert.equal((await app.request(app.path(id), 'POST', input, 'carol')).status, 400);
    assert.equal((await app.request(app.path(id), 'POST', { ...input, reviewerId: app.bob.id }, 'carol', 'spoof')).status, 400);
    assert.equal((await app.request(app.path(id), 'POST', { ...input, extra: true }, 'carol', 'extra')).status, 400);
    app.store.saveReview(id, 1, { provider: 'local', model: 'fixture-check', summary: 'Additional recorded evidence', findings: [] }, app.actor);
    assert.equal((await app.request(app.path(id), 'POST', input, 'carol', 'uninspected-evidence')).status, 409);
    const inspected = app.input(id, 'accept');
    const responses = await Promise.all(['race-one', 'race-two'].map(key => app.request(app.path(id), 'POST', inspected, 'carol', key))); assert.deepEqual(responses.map(result => result.status).sort(), [200, 409]);
    const winner = responses[0]!.status === 200 ? 'race-one' : 'race-two'; assert.equal((await app.request(app.path(id), 'POST', { ...inspected, message: 'Changed intent' }, 'carol', winner)).status, 409);
  } finally { await app.close(); }
});

test('cookie-authenticated reviewer decisions require the current session context and CSRF token', async () => {
  const app = await start(); const cookies = new Map<string, string>();
  const acceptCookies = (headers: Headers) => { for (const cookie of headers.getSetCookie()) { const pair = cookie.split(';')[0]!, split = pair.indexOf('='), name = pair.slice(0, split); if (/max-age=0(?:;|$)/i.test(cookie)) cookies.delete(name); else cookies.set(name, pair.slice(split + 1)); } };
  const cookieHeader = () => [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  try {
    const id = app.revision().revision.id;
    const bootstrap = await fetch(app.origin + '/api/session'); acceptCookies(bootstrap.headers); const boot = await bootstrap.json() as SessionState;
    const login = await fetch(app.origin + '/api/login', { method: 'POST', headers: { Cookie: cookieHeader(), Origin: app.origin, 'Content-Type': 'application/json', 'X-CSRF-Token': boot.csrfToken! }, body: JSON.stringify({ username: 'carol', password: 'Carol reviewer API password long enough' }) }); assert.equal(login.status, 200); acceptCookies(login.headers); const session = await login.json() as SessionState;
    const data = app.input(id, 'accept'), headers = { Cookie: cookieHeader(), Origin: app.origin, 'Content-Type': 'application/json', 'Idempotency-Key': 'cookie-review', 'X-Session-Context': session.sessionContext!, 'X-CSRF-Token': session.csrfToken! };
    for (const [invalid, status] of [[{ ...headers, 'X-CSRF-Token': 'invalid' }, 403], [{ ...headers, 'X-Session-Context': 'other-session' }, 401]] as const) assert.equal((await fetch(app.origin + app.path(id), { method: 'POST', headers: invalid, body: JSON.stringify(data) })).status, status);
    const saved = await fetch(app.origin + app.path(id), { method: 'POST', headers, body: JSON.stringify(data) }); assert.equal(saved.status, 200); assert.equal(app.store.detail(id).revision.status, 'accepted');
  } finally { await app.close(); }
});

test('reviewer membership grants no visibility and historical retries recheck action-specific current authority', async () => {
  const app = await start();
  try {
    const id = app.revision().revision.id, saved = await app.act(id, 'add', 'bob', app.carol.id, 'membership');
    app.policy(id, { view: members(app.alice.id, app.bob.id) }); assert.equal((await app.request(app.path(id), 'GET', undefined, 'carol')).status, 404);
    app.policy(id, { view: workspace }); const decision = await app.act(id, 'accept');
    const old = app.tokens.carol.record.id; app.tokens.carol = app.auth.createToken(app.carol.id, { name: 'Rotated', scopes: ['read', 'write'] }); app.auth.revokeToken(app.carol.id, old);
    const rotated = await app.request<RevisionReviewerReceipt>(app.path(id), 'POST', decision.data, 'carol', decision.key); assert.equal(rotated.status, 200); assert.deepEqual(rotated.body.transaction, decision.receipt.transaction); assert.equal(rotated.body.accessEpoch, app.policies.epoch());
    app.auth.setAccountDisabled(app.carol.id, true); assert.equal((await app.request(app.path(id), 'POST', saved.data, 'bob', saved.key)).status, 200, 'historical membership remains provable after recipient disable');
    app.policy(id, { edit: members(app.alice.id) }); assert.equal((await app.request(app.path(id), 'POST', saved.data, 'bob', saved.key)).status, 403);
    app.auth.setAccountDisabled(app.carol.id, false); app.tokens.carol = app.auth.createToken(app.carol.id, { name: 'Renewed', scopes: ['read', 'write'] });
    app.policy(id, { interact: members(app.alice.id) }); assert.equal((await app.request(app.path(id), 'POST', decision.data, 'carol', decision.key)).status, 403);
    app.policy(id, { view: members(app.alice.id) }); const denied = await app.request(app.path(id), 'POST', decision.data, 'carol', decision.key); assert.equal(denied.status, 404); assert.deepEqual(denied.body, (await app.request('/api/revisions/P999999/reviewers', 'POST', decision.data, 'carol', decision.key)).body);
  } finally { await app.close(); }
});

test('reviewer receipts cannot borrow canonical operations, hidden source or another principal', async () => {
  const app = await start();
  try {
    const id = app.revision().revision.id, saved = await app.act(id, 'accept', 'carol', undefined, 'protected-review');
    const other = app.revision().revision.id, foreign = await app.act(other, 'accept', 'carol'); app.policy(other, { view: members(app.alice.id) });
    const row = app.store.database.prepare('SELECT key,body FROM idempotency WHERE key LIKE ?').get('%:protected-review') as { key: string; body: string };
    const getter = app.store.revisionReviewers.operation.bind(app.store.revisionReviewers);
    let hiddenLoads = 0;
    app.store.revisionReviewers.operation = operationId => { if (operationId === foreign.receipt.operationId) { hiddenLoads++; throw new Error('Hidden operation must not load'); } return getter(operationId); };
    for (const body of [foreign.receipt, { ...saved.receipt, operationId: foreign.receipt.operationId }, { ...saved.receipt, inputSha256: 'a'.repeat(64) }, { ...saved.receipt, transaction: { ...saved.receipt.transaction, message: 'Forged message' } }]) {
      app.store.database.prepare('UPDATE idempotency SET body=? WHERE key=?').run(JSON.stringify(body), row.key);
      const result = await app.request(app.path(id), 'POST', saved.data, 'carol', saved.key); assert.equal(result.status, 409); assert.equal(result.body.code, 'REVISION_REVIEWER_INVALID_RECEIPT');
    }
    assert.equal(hiddenLoads, 0, 'hidden operation must be rejected by its source owner before loading evidence');
    app.store.database.prepare('UPDATE idempotency SET body=? WHERE key=?').run(row.body, row.key); assert.equal((await app.request(app.path(id), 'POST', saved.data, 'carol', saved.key)).status, 200);
    const foreignKey = `${app.auth.workspaceId}:${app.bob.id}:stolen-review`, original = app.store.database.prepare('SELECT * FROM idempotency WHERE key=?').get(row.key)!;
    app.store.database.prepare('INSERT INTO idempotency(key,fingerprint,status,body,created_at) VALUES(?,?,?,?,?)').run(foreignKey, original.fingerprint as string, original.status as number, original.body as string, original.created_at as string);
    assert.equal((await app.request(app.path(id), 'POST', saved.data, 'bob', 'stolen-review')).status, 409);
  } finally { await app.close(); }
});

test('Word reviewers can accept exact packages without fabricated machine evidence and lose access with the source File Space', async () => {
  const app = await start();
  try {
    const bytes = await readFile(new URL('../tests/fixtures/docx/roundtrip.docx', import.meta.url));
    const upload = await app.request<FileRecord>('/api/files', 'POST', { name: 'Review.docx', dataBase64: bytes.toString('base64'), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }, 'alice', 'word-upload'); assert.equal(upload.status, 201);
    const file = upload.body, imported = await app.request<RevisionDetail>('/api/revisions/docx', 'POST', { title: 'Reviewed Word package', sourceFile: { fileId: file.id, sha256: file.sha256, bytes: file.bytes }, shareSource: true, expectedAccessEpoch: app.policies.epoch() }, 'alice', 'word-import'); assert.equal(imported.status, 201, JSON.stringify(imported.body));
    const id = imported.body.revision.id; app.policy(id, { edit: members(app.alice.id), interact: workspace });
    const saved = await app.act(id, 'accept'); assert.equal(app.store.detail(id).revision.status, 'accepted'); assert.deepEqual(app.store.detail(id).reviews, []); assert.deepEqual(app.store.detail(id).versions, imported.body.versions);
    const space = app.policies.createSpace({ name: 'Private Word package', view: members(app.alice.id), edit: members(app.alice.id) }, app.alice.id); app.policy(file.id, { spaceId: space.id });
    for (const suffix of ['', '/history']) assert.equal((await app.request(app.path(id) + suffix, 'GET', undefined, 'carol')).status, 404);
    assert.equal((await app.request(app.path(id), 'POST', saved.data, 'carol', saved.key)).status, 404);
  } finally { await app.close(); }
});

test('repository and revision Space ceilings override membership and prevent saved decision disclosure', async () => {
  const app = await start();
  try {
    for (const ceiling of ['repository', 'revision-space'] as const) {
      const repository = app.store.createRepository({ name: 'Reviewer source', remoteUrl: 'https://example.test/review.git', description: '', defaultBranch: 'main' });
      const id = app.revision('code', { repositoryId: repository.id }).revision.id; await app.act(id, 'add', 'bob', app.carol.id); const saved = await app.act(id, 'accept');
      if (ceiling === 'repository') app.policy(repository.id, { view: members(app.alice.id), edit: members(app.alice.id) });
      else { const space = app.policies.createSpace({ name: 'Private revision Space', view: members(app.alice.id), edit: members(app.alice.id) }, app.alice.id); app.policy(id, { spaceId: space.id }); }
      for (const suffix of ['', '/history']) assert.equal((await app.request(app.path(id) + suffix, 'GET', undefined, 'carol')).status, 404);
      assert.equal((await app.request(app.path(id), 'POST', saved.data, 'carol', saved.key)).status, 404);
      assert.equal(app.store.detail(id).revision.status, 'accepted', 'permission revocation does not rewrite immutable review evidence');
    }
  } finally { await app.close(); }
});

test('reviewer decision authorization is checked under the SQLite writer lock for fresh and saved requests', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'phab-reviewer-lock-')), databasePath = join(directory, 'workspace.sqlite'), app = await start('/', false, databasePath), transaction = app.store.transaction.bind(app.store);
  try {
    for (const phase of ['fresh', 'replay'] as const) {
      const id = app.revision().revision.id, data = app.input(id, 'accept'), key = `reviewer-lock-${phase}`;
      let replay: { key: string; fingerprint: string; status: number; body: string; created_at: string } | undefined;
      if (phase === 'replay') { assert.equal((await app.request(app.path(id), 'POST', data, 'carol', key)).status, 200); replay = app.store.database.prepare('SELECT * FROM idempotency WHERE key LIKE ?').get(`%:${key}`) as typeof replay; assert.ok(replay); app.store.database.prepare('DELETE FROM idempotency WHERE key=?').run(replay.key); }
      const original = app.policies.policy(id, app.alice.id), policy = { ...original, version: original.version + 1, rules: { ...original.rules, interact: members(app.alice.id) } }, before = app.store.detail(id), history = app.store.revisionReviewers.history(id);
      const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(`
        import { parentPort, workerData } from 'node:worker_threads'; import { DatabaseSync } from 'node:sqlite';
        const db=new DatabaseSync(workerData.databasePath);db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');db.prepare('UPDATE object_policies SET data=? WHERE object_id=?').run(JSON.stringify(workerData.policy),workerData.policy.objectId);db.prepare("UPDATE policy_meta SET value=value+1 WHERE name='epoch'").run();
        if(workerData.replay){const r=workerData.replay;db.prepare('INSERT INTO idempotency(key,fingerprint,status,body,created_at) VALUES(?,?,?,?,?)').run(r.key,r.fingerprint,r.status,r.body,r.created_at);}parentPort.once('message',()=>{db.exec('COMMIT');db.close();parentPort.close();});parentPort.postMessage('locked');
      `)}`), { workerData: { databasePath, policy, replay } });
      try {
        assert.deepEqual(await once(worker, 'message'), ['locked']); let entered = 0;
        app.store.transaction = function<T>(work: () => T): T { entered++; app.store.transaction = transaction; worker.postMessage('commit'); return transaction(work); };
        const denied = await app.request(app.path(id), 'POST', data, 'carol', key); assert.equal(entered, 1); assert.equal(denied.status, 403); assert.deepEqual(app.store.detail(id), before); assert.deepEqual(app.store.revisionReviewers.history(id), history);
      } finally { app.store.transaction = transaction; await worker.terminate(); }
    }
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
