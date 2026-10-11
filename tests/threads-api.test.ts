import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { createApp } from '../server/app.ts';
import { createAuth } from '../server/auth.ts';
import { createStore } from '../server/store.ts';
import type { Audience, ObjectAccess } from '../shared/policy.ts';
import type { RevisionAuthorshipSnapshot } from '../shared/revision-authorship.ts';
import type { RevisionDetail, ReviewComment, ReviewThread } from '../shared/types.ts';

type ErrorBody = { error: string; code?: string };
const workspace: Audience = { kind: 'workspace' };
const selected = (...principalIds: string[]): Audience => ({ kind: 'principals', principalIds });
const source = 'Introduction.\nThis claim needs a citation.\nConcluding paragraph.\n';
const revisionInput = { title: 'Passage review fixture', kind: 'document', files: [{ path: 'motion.md', content: source }] };

async function start(databasePath = ':memory:') {
  const store = createStore({ path: databasePath });
  const provisioning = createAuth({ database: store.database, mode: 'local', basePath: '/', provisioning: true });
  const alice = await provisioning.createAccount({ username: 'alice', displayName: 'Alice Writer', password: 'Alice thread test password long enough' });
  const bob = await provisioning.createAccount({ username: 'bob', displayName: 'Bob Reviewer', password: 'Bob thread test password long enough' });
  const app = createApp({ store, seed: false, authMode: 'password' });
  const tokens = {
    alice: app.auth.createToken(alice.id, { name: 'Writer', scopes: ['read', 'write'] }).token,
    bob: app.auth.createToken(bob.id, { name: 'Reviewer', scopes: ['read', 'write'] }).token,
    reader: app.auth.createToken(bob.id, { name: 'Read only', scopes: ['read'] }).token,
  };
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  async function request<T = ErrorBody>(actor: keyof typeof tokens, path: string, method = 'GET', body?: unknown, key?: string) {
    const response = await fetch(origin + path, {
      method, signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${tokens[actor]}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as T };
  }
  async function create<T>(actor: keyof typeof tokens, path: string, body: unknown, key?: string): Promise<T> {
    const response = await request<T>(actor, path, 'POST', body, key);
    assert.equal(response.status, 201, JSON.stringify(response.body)); return response.body;
  }
  async function restrict(id: string, changes: Partial<Record<'view' | 'edit' | 'interact', Audience>>) {
    const current = (await request<ObjectAccess>('alice', `/api/policies/${id}`)).body.policy;
    const response = await request('alice', `/api/policies/${id}`, 'PUT', { expectedVersion: current.version, spaceId: current.spaceId, ...current.rules, ...changes });
    assert.equal(response.status, 200, JSON.stringify(response.body));
  }
  return { ...app, origin, alice, bob, request, create, restrict, close: async () => { await app.close(); store.close(); } };
}

test('passage threads keep immutable anchors, replies, resolution provenance and optimistic conflicts through the HTTP API', async () => {
  const app = await start();
  try {
    const created = await app.create<RevisionDetail>('alice', '/api/revisions', revisionInput);
    const path = `/api/revisions/${created.revision.id}`; const v1 = created.versions[0]!;
    const quote = 'This claim needs a citation.'; const start = source.indexOf(quote);
    const root = await app.create<ReviewComment>('bob', `${path}/comments`, { body: 'Please substantiate this claim.', versionId: v1.id, filePath: 'motion.md', passage: { start, end: start + quote.length, quote } }, 'passage-root');
    assert.equal(root.anchor?.quote, quote); assert.equal(root.anchor?.contentHash, v1.contentHash);
    assert.equal(root.threadId, root.id); assert.equal(root.attribution?.principalId, app.bob.id);
    const updated = await app.create<RevisionDetail>('alice', `${path}/versions`, { expectedVersion: 1, message: 'Add background before claim', files: [{ path: 'motion.md', content: 'New background.\n' + source }] });
    const v2 = updated.versions[1]!;
    const replyBody = { body: 'The supporting source is in the next paragraph.', viewedVersionId: v2.id };
    const reply = await app.create<ReviewComment>('alice', `${path}/threads/${root.id}/replies`, replyBody, 'thread-reply');
    assert.equal(reply.threadId, root.id); assert.equal(reply.versionId, v1.id);
    assert.equal(reply.viewedVersionId, v2.id); assert.deepEqual(reply.anchor, root.anchor);
    assert.equal(reply.filePath, root.filePath); assert.equal(reply.line, root.line);
    assert.deepEqual(await app.create('alice', `${path}/threads/${root.id}/replies`, replyBody, 'thread-reply'), reply);
    const resolve = { status: 'resolved', expectedThreadVersion: 2, versionId: v2.id };
    const attempts = await Promise.all(['resolve-a', 'resolve-b'].map(key => app.request<ReviewThread>('alice', `${path}/threads/${root.id}`, 'PATCH', resolve, key)));
    assert.deepEqual(attempts.map(result => result.status).sort(), [200, 409]);
    const winner = attempts.findIndex(result => result.status === 200);
    assert.deepEqual((await app.request('alice', `${path}/threads/${root.id}`, 'PATCH', resolve, winner === 0 ? 'resolve-a' : 'resolve-b')).body, attempts[winner]!.body);
    const later = await app.create<ReviewComment>('bob', `${path}/threads/${root.id}/replies`, { body: 'One more question remains.', viewedVersionId: v2.id });
    assert.equal(later.threadId, root.id);
    assert.equal((await app.request('alice', `${path}/threads/${root.id}`, 'PATCH', { status: 'open', expectedThreadVersion: 3, versionId: v2.id })).status, 409, 'a new reply invalidates the old state version');
    assert.equal((await app.request('alice', `${path}/threads/${root.id}`, 'PATCH', { status: 'open', expectedThreadVersion: 4, versionId: v2.id })).status, 200);
    const final = (await app.request<RevisionDetail>('alice', path)).body;
    assert.equal(final.comments.length, 3); assert.equal(final.threads.length, 1);
    assert.equal(final.threads[0]!.version, 5); assert.equal(final.threads[0]!.status, 'open');
    assert.deepEqual(final.threadEvents.map(event => [event.action, event.versionId, event.threadVersion]), [['resolved', v2.id, 3], ['reopened', v2.id, 5]]);
    assert.ok(final.threadEvents.every(event => event.attribution?.principalId === app.alice.id));
    assert.deepEqual(final.comments.find(comment => comment.id === root.id), root);
    assert.deepEqual(final.versions, updated.versions); assert.equal(final.reviews.length, 0); assert.equal(final.revision.status, 'needs_review');
    const foreign = await app.create<RevisionDetail>('alice', '/api/revisions', revisionInput);
    const wrongParent = await app.request('alice', `/api/revisions/${foreign.revision.id}/threads/${root.id}/replies`, 'POST', replyBody);
    assert.equal(wrongParent.status, 404);
    assert.notEqual(wrongParent.body.code, 'OBJECT_UNAVAILABLE', 'a missing child must not revoke its visible parent in the browser');
    assert.equal((await app.request('alice', `${path}/threads/${root.id}/replies`, 'POST', { body: 'Invalid viewed version', viewedVersionId: foreign.versions[0]!.id })).status, 400);
  } finally { await app.close(); }
});

test('thread replies require interact and write scope, resolution requires edit, and hidden threads never disclose saved responses', async () => {
  const app = await start();
  try {
    const created = await app.create<RevisionDetail>('alice', '/api/revisions', { ...revisionInput, access: { spaceId: 'S1', view: workspace, edit: selected(app.alice.id), interact: workspace } });
    const path = `/api/revisions/${created.revision.id}`; const versionId = created.versions[0]!.id;
    const root = await app.create<ReviewComment>('alice', `${path}/comments`, { versionId, body: 'Confidential thread wording', filePath: 'motion.md', line: 2 });
    const replies = `${path}/threads/${root.id}/replies`; const state = `${path}/threads/${root.id}`;
    const reply = { body: 'Saved response must remain protected', viewedVersionId: versionId };
    await app.create('bob', replies, reply, 'protected-reply');
    assert.equal((await app.request('reader', replies, 'POST', reply)).status, 403);
    assert.equal((await app.request('bob', state, 'PATCH', { status: 'resolved', expectedThreadVersion: 2, versionId })).status, 403);
    await app.restrict(created.revision.id, { interact: selected(app.alice.id) });
    assert.equal((await app.request('bob', replies, 'POST', reply, 'protected-reply')).status, 403);
    const stateBody = { status: 'resolved', expectedThreadVersion: 2, versionId };
    assert.equal((await app.request('alice', state, 'PATCH', stateBody, 'protected-state')).status, 200);
    // Transfer current authorship before revoking the former author's explicit access.
    await app.restrict(created.revision.id, { edit: workspace, interact: workspace });
    const authorship = (await app.request<RevisionAuthorshipSnapshot>('alice', `${path}/authorship`)).body;
    assert.equal((await app.request('alice', `${path}/authorship`, 'POST', {
      action: 'assign', authorId: app.bob.id, message: 'Hand over responsibility for this discussion.',
      expectedAuthorVersion: authorship.authorship.version, expectedVersion: authorship.head.number,
      expectedVersionId: authorship.head.versionId, expectedContentHash: authorship.head.contentHash,
      expectedAccessEpoch: authorship.accessEpoch,
    }, 'handoff-before-thread-revocation')).status, 200);
    const policy = (await app.request<ObjectAccess>('bob', `/api/policies/${created.revision.id}`)).body.policy;
    const changed = await app.request('bob', `/api/policies/${created.revision.id}`, 'PUT', { expectedVersion: policy.version, spaceId: policy.spaceId, view: selected(app.bob.id), edit: selected(app.bob.id), interact: selected(app.bob.id) });
    assert.equal(changed.status, 200);
    const hidden = await app.request('alice', path);
    assert.deepEqual(hidden, await app.request('alice', '/api/revisions/L999999'));
    assert.equal(hidden.status, 404); assert.equal(hidden.body.code, 'OBJECT_UNAVAILABLE');
    const hiddenReplay = await app.request('alice', state, 'PATCH', stateBody, 'protected-state');
    assert.deepEqual(hiddenReplay, hidden);
    assert.deepEqual(await app.request('alice', replies, 'POST', reply), hidden);
    assert.equal((await fetch(app.origin + path)).status, 401);
    assert.equal(app.store.detail(created.revision.id).comments.length, 2);
    assert.equal(app.store.detail(created.revision.id).threadEvents.length, 1);
  } finally { await app.close(); }
});

test('legacy detail retries project historical one-message threads without borrowing unseen current replies or rewriting saved responses', async () => {
  const app = await start();
  try {
    const created = await app.create<RevisionDetail>('alice', '/api/revisions', revisionInput);
    const path = `/api/revisions/${created.revision.id}`; const v1 = created.versions[0]!;
    const root = await app.create<ReviewComment>('alice', `${path}/comments`, { versionId: v1.id, body: 'A legacy one-message discussion.' });
    const input = { expectedVersion: 1, message: 'Legacy saved version', files: [{ path: 'motion.md', content: source + 'More text.\n' }] };
    const saved = await app.create<RevisionDetail>('alice', `${path}/versions`, input, 'legacy-version');
    const { threads: _threads, threadEvents: _events, ...old } = saved;
    const legacy = JSON.stringify({ ...old, comments: old.comments.map(({ threadId: _threadId, anchor: _anchor, viewedVersionId: _viewed, ...comment }) => comment) });
    app.store.database.prepare('UPDATE idempotency SET body = ? WHERE key LIKE ?').run(legacy, '%:legacy-version');
    await app.create('bob', `${path}/threads/${root.id}/replies`, { body: 'A new reply after the old snapshot.', viewedVersionId: saved.versions[1]!.id });
    const replay = await app.create<RevisionDetail>('alice', `${path}/versions`, input, 'legacy-version');
    assert.equal(replay.comments.length, 1); assert.equal(replay.threads.length, 1);
    assert.equal(replay.threads[0]!.id, root.id); assert.equal(replay.threads[0]!.version, 1); assert.equal(replay.threads[0]!.status, 'open');
    assert.deepEqual(replay.threadEvents, []);
    assert.equal((app.store.database.prepare('SELECT body FROM idempotency WHERE key LIKE ?').get('%:legacy-version') as { body: string }).body, legacy);
    assert.equal((await app.request('alice', `${path}/threads/${root.id}`, 'PATCH', { expectedThreadVersion: 1, versionId: v1.id, status: 'resolved' })).status, 409);
    assert.equal((await app.request<RevisionDetail>('alice', path)).body.comments.length, 2);
  } finally { await app.close(); }
});

test('a thread reply and its saved response recheck policy after a competing writer commits revocation', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'phabricator-thread-lock-')); const databasePath = join(directory, 'workspace.sqlite');
  const app = await start(databasePath); const transaction = app.store.transaction.bind(app.store);
  try {
    for (const phase of ['write', 'replay'] as const) {
      const created = await app.create<RevisionDetail>('alice', '/api/revisions', revisionInput);
      const path = `/api/revisions/${created.revision.id}`; const versionId = created.versions[0]!.id;
      const root = await app.create<ReviewComment>('alice', `${path}/comments`, { body: 'Locked thread', versionId });
      const replies = `${path}/threads/${root.id}/replies`; const body = { body: `Concurrent ${phase}`, viewedVersionId: versionId }; const key = `thread-lock-${phase}`;
      let replay: { key: string; fingerprint: string; status: number; body: string; created_at: string } | undefined;
      if (phase === 'replay') {
        await app.create('bob', replies, body, key);
        replay = app.store.database.prepare('SELECT * FROM idempotency WHERE key LIKE ?').get(`%:${key}`) as typeof replay;
        assert.ok(replay); app.store.database.prepare('DELETE FROM idempotency WHERE key = ?').run(replay.key);
      }
      const before = app.store.detail(created.revision.id);
      const policy = (await app.request<ObjectAccess>('alice', `/api/policies/${created.revision.id}`)).body.policy;
      const restricted = { ...policy, version: policy.version + 1, rules: { view: selected(app.alice.id), edit: selected(app.alice.id), interact: selected(app.alice.id) } };
      const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(`
        import { parentPort, workerData } from 'node:worker_threads';
        import { DatabaseSync } from 'node:sqlite';
        const database = new DatabaseSync(workerData.databasePath);
        database.exec('PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE');
        database.prepare('UPDATE object_policies SET data = ? WHERE object_id = ?').run(JSON.stringify(workerData.policy), workerData.policy.objectId);
        database.prepare("UPDATE policy_meta SET value = value + 1 WHERE name = 'epoch'").run();
        if (workerData.replay) { const r = workerData.replay; database.prepare('INSERT INTO idempotency (key, fingerprint, status, body, created_at) VALUES (?, ?, ?, ?, ?)').run(r.key, r.fingerprint, r.status, r.body, r.created_at); }
        parentPort.once('message', () => { database.exec('COMMIT'); database.close(); parentPort.close(); });
        parentPort.postMessage('locked');
      `)}`), { workerData: { databasePath, policy: restricted, replay } });
      try {
        assert.deepEqual(await once(worker, 'message'), ['locked']);
        let entered = 0;
        app.store.transaction = function<T>(work: () => T): T { entered += 1; app.store.transaction = transaction; worker.postMessage('commit'); return transaction(work); };
        const denied = await app.request('bob', replies, 'POST', body, key);
        assert.equal(entered, 1); assert.equal(denied.status, 404); assert.equal(denied.body.code, 'OBJECT_UNAVAILABLE');
        const after = app.store.detail(created.revision.id);
        assert.deepEqual(after.comments, before.comments); assert.deepEqual(after.threads, before.threads);
        assert.deepEqual(after.threadEvents, before.threadEvents); assert.deepEqual(after.activity, before.activity);
      } finally { app.store.transaction = transaction; await worker.terminate(); }
    }
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
