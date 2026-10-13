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
import { createPassageAnchor } from '../shared/anchors.ts';
import type { Audience, ObjectAccess } from '../shared/policy.ts';
import type { RevisionAuthorshipSnapshot } from '../shared/revision-authorship.ts';
import type { RevisionLifecycleSnapshot } from '../shared/revision-lifecycle.ts';
import type { ReviewDraftChangeReceipt, ReviewDraftPreview, ReviewDraftPublicationReceipt } from '../shared/review-drafts.ts';
import type { ApplySuggestionInput, RevisionDetail, ReviewComment } from '../shared/types.ts';

type ErrorBody = { error: string; code?: string };
const workspace: Audience = { kind: 'workspace' };
const selected = (...principalIds: string[]): Audience => ({ kind: 'principals', principalIds });
const quote = 'seven days';
const source = 'Fictional motion for testing.\r\nThe requested extension is seven days.\r\nThank you. 🧪\r\n';
const sourceFiles = [{ path: 'motion.md', content: source }, { path: 'citations.bib', content: 'An unchanged companion file.\r\n' }];
const createInput = { testPlan: 'Fixture verification plan.', title: 'Suggested edit fixture', kind: 'document', files: sourceFiles };

async function start(databasePath = ':memory:') {
  const store = createStore({ path: databasePath });
  const provisioning = createAuth({ database: store.database, mode: 'local', basePath: '/', provisioning: true });
  const alice = await provisioning.createAccount({ username: 'alice', displayName: 'Alice Writer', password: 'Alice suggested edit password long enough' });
  const bob = await provisioning.createAccount({ username: 'bob', displayName: 'Bob Reviewer', password: 'Bob suggested edit password long enough' });
  const app = createApp({ store, seed: false, authMode: 'password' });
  const tokens = {
    alice: app.auth.createToken(alice.id, { name: 'Writer', scopes: ['read', 'write', 'review:local'] }).token,
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
  async function suggest(detail: RevisionDetail, actor: keyof typeof tokens = 'bob', replacement = 'fourteen days') {
    const version = detail.versions.find(item => item.number === detail.revision.currentVersion)!;
    const text = version.files.find(file => file.path === 'motion.md')!.content;
    const start = text.indexOf(quote);
    return create<ReviewComment>(actor, `/api/revisions/${detail.revision.id}/comments`, { body: 'Make the requested duration precise.', versionId: version.id, filePath: 'motion.md', passage: { start, end: start + quote.length, quote }, suggestion: { replacement } });
  }
  const input = (detail: RevisionDetail, expectedThreadVersion = 1): ApplySuggestionInput => {
    const current = detail.versions.find(item => item.number === detail.revision.currentVersion)!;
    return { expectedVersion: current.number, expectedVersionId: current.id, expectedContentHash: current.contentHash, expectedThreadVersion };
  };
  async function acceptReviewed(id: string) {
    const result = await request<RevisionLifecycleSnapshot>('alice', `/api/revisions/${id}/lifecycle`);
    assert.equal(result.status, 200); const s = result.body;
    return request('alice', `/api/revisions/${id}/lifecycle`, 'POST', { action: 'accept_reviewed', message: '', expectedLifecycleVersion: s.lifecycle.version, expectedReviewerVersion: s.reviewers.version, expectedAuthorVersion: s.authorship.version, expectedVersion: s.head.number, expectedVersionId: s.head.versionId, expectedContentHash: s.head.contentHash, expectedAccessEpoch: s.accessEpoch, expectedConfigId: s.configId, expectedEvidenceSha256: s.evidence.sha256 }, crypto.randomUUID());
  }
  return { ...app, alice, bob, request, create, suggest, input, acceptReviewed, close: async () => { await app.close(); store.close(); } };
}

test('an explicit suggested edit changes only its exact passage once and invalidates old acceptance', async () => {
  const app = await start();
  try {
    const before = await app.create<RevisionDetail>('alice', '/api/revisions', createInput);
    const path = `/api/revisions/${before.revision.id}`;
    const proposal = await app.suggest(before);
    await app.create('alice', `${path}/reviews`, { provider: 'local', expectedVersion: 1 });
    assert.equal((await app.acceptReviewed(before.revision.id)).status, 200);
    const endpoint = `${path}/suggestions/${proposal.id}/apply`; const input = app.input(before);
    const applied = await app.create<RevisionDetail>('alice', endpoint, input, 'apply-once');
    assert.equal(applied.revision.currentVersion, 2); assert.equal(applied.revision.status, 'needs_review');
    assert.deepEqual(applied.versions[0], before.versions[0]);
    assert.deepEqual(applied.versions[1]!.files, [{ ...sourceFiles[0]!, content: source.replace(quote, 'fourteen days') }, sourceFiles[1]!]);
    assert.deepEqual(applied.comments, [proposal]); assert.equal(applied.reviews.length, 1);
    assert.equal(applied.reviews[0]!.versionId, before.versions[0]!.id);
    assert.equal(applied.threads[0]!.status, 'open'); assert.equal(applied.threads[0]!.version, 2); assert.deepEqual(applied.threadEvents, []);
    const evidence = applied.suggestionApplications[0]!;
    assert.equal(applied.suggestionApplications.length, 1); assert.equal(evidence.commentId, proposal.id); assert.equal(evidence.threadId, proposal.id);
    assert.equal(evidence.fromVersionId, before.versions[0]!.id); assert.equal(evidence.toVersionId, applied.versions[1]!.id);
    assert.equal(evidence.fromContentHash, before.versions[0]!.contentHash); assert.equal(evidence.toContentHash, applied.versions[1]!.contentHash);
    assert.equal(evidence.attribution?.principalId, app.alice.id); assert.equal(evidence.threadVersion, 2);
    assert.deepEqual(await app.create('alice', endpoint, input, 'apply-once'), applied);
    assert.equal((await app.request('alice', endpoint, 'POST', input, 'apply-again')).status, 409);
    assert.equal((await app.acceptReviewed(before.revision.id)).status, 409);
    assert.equal(app.store.detail(before.revision.id).versions.length, 2);
  } finally { await app.close(); }
});

test('applying suggestions requires current edit and write authority while proposing requires interaction', async () => {
  const app = await start();
  try {
    const before = await app.create<RevisionDetail>('alice', '/api/revisions', { ...createInput, access: { spaceId: 'S1', view: workspace, edit: selected(app.alice.id), interact: workspace } });
    const path = `/api/revisions/${before.revision.id}`; const proposal = await app.suggest(before);
    const endpoint = `${path}/suggestions/${proposal.id}/apply`; const input = app.input(before);
    assert.equal((await app.request('bob', endpoint, 'POST', input)).status, 403);
    assert.equal((await app.request('reader', endpoint, 'POST', input)).status, 403);
    const missing = await app.request('alice', `${path}/suggestions/missing-proposal/apply`, 'POST', input);
    assert.equal(missing.status, 404); assert.notEqual(missing.body.code, 'OBJECT_UNAVAILABLE');
    await app.create('alice', endpoint, input, 'protected-apply');
    const current = (await app.request<ObjectAccess>('alice', `/api/policies/${before.revision.id}`)).body.policy;
    assert.equal((await app.request('alice', `/api/policies/${before.revision.id}`, 'PUT', { expectedVersion: current.version, spaceId: 'S1', view: workspace, edit: workspace, interact: workspace })).status, 200);
    const authorship = (await app.request<RevisionAuthorshipSnapshot>('alice', `${path}/authorship`)).body;
    assert.equal((await app.request('alice', `${path}/authorship`, 'POST', {
      action: 'assign', authorId: app.bob.id, message: 'Hand over the manuscript before access is revoked.',
      expectedAuthorVersion: authorship.authorship.version, expectedReviewerVersion: authorship.reviewerVersion, expectedLifecycleVersion: authorship.lifecycleVersion, expectedVersion: authorship.head.number,
      expectedVersionId: authorship.head.versionId, expectedContentHash: authorship.head.contentHash,
      expectedAccessEpoch: authorship.accessEpoch,
    }, 'handoff-before-apply-revocation')).status, 200);
    const transferable = (await app.request<ObjectAccess>('bob', `/api/policies/${before.revision.id}`)).body.policy;
    assert.equal((await app.request('bob', `/api/policies/${before.revision.id}`, 'PUT', { expectedVersion: transferable.version, spaceId: 'S1', view: selected(app.bob.id), edit: selected(app.bob.id), interact: selected(app.bob.id) })).status, 200);
    const denied = await app.request('alice', endpoint, 'POST', input, 'protected-apply');
    assert.equal(denied.status, 404); assert.equal(denied.body.code, 'OBJECT_UNAVAILABLE');
    assert.deepEqual(denied, await app.request('alice', '/api/revisions/L999999/suggestions/missing/apply', 'POST', input));
    assert.deepEqual(denied, await app.request('alice', path));
    assert.equal(app.store.detail(before.revision.id).versions.length, 2);
  } finally { await app.close(); }
});

test('a concurrent reply or source edit prevents applying a stale proposal without partial history', async () => {
  const app = await start();
  try {
    const before = await app.create<RevisionDetail>('alice', '/api/revisions', createInput); const path = `/api/revisions/${before.revision.id}`;
    const proposal = await app.suggest(before); const endpoint = `${path}/suggestions/${proposal.id}/apply`;
    await app.create('bob', `${path}/threads/${proposal.id}/replies`, { body: 'Wait: verify the new requested duration.', viewedVersionId: before.versions[0]!.id });
    assert.equal((await app.request('alice', endpoint, 'POST', app.input(before))).status, 409);
    const newer = await app.create<RevisionDetail>('alice', `${path}/versions`, { expectedVersion: 1, message: 'Add context', files: [{ ...sourceFiles[0]!, content: 'More context.\r\n' + source }, sourceFiles[1]] });
    const stale = await app.request('alice', endpoint, 'POST', app.input(newer, 2));
    assert.equal(stale.status, 409, 'even a unique unchanged quote needs a fresh proposal on a newer source version');
    const detail = (await app.request<RevisionDetail>('alice', path)).body;
    assert.equal(detail.versions.length, 2); assert.equal(detail.suggestionApplications.length, 0); assert.equal(detail.threads[0]!.version, 2);
    const fresh = await app.suggest(detail, 'alice', '');
    const input = app.input(detail); const freshEndpoint = `${path}/suggestions/${fresh.id}/apply`;
    const raced = await Promise.all(['simultaneous-a', 'simultaneous-b'].map(key => app.request<RevisionDetail>('alice', freshEndpoint, 'POST', input, key)));
    assert.deepEqual(raced.map(result => result.status).sort(), [201, 409]);
    const final = app.store.detail(before.revision.id);
    assert.equal(final.versions.length, 3); assert.equal(final.suggestionApplications.length, 1);
    assert.equal(final.versions[2]!.files[0]!.content, ('More context.\r\n' + source).replace(quote, ''));
    assert.deepEqual(final.versions[2]!.files[1], sourceFiles[1]);
  } finally { await app.close(); }
});

test('suggestion application rechecks revocation after waiting for a SQLite writer, including saved-result disclosure', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'phabricator-suggestion-lock-')); const databasePath = join(directory, 'workspace.sqlite');
  const app = await start(databasePath); const transaction = app.store.transaction.bind(app.store);
  try {
    for (const phase of ['write', 'replay'] as const) {
      // Alice edits another author's manuscript, so removing her explicit access can revoke the operation.
      const created = await app.create<RevisionDetail>('bob', '/api/revisions', createInput); const proposal = await app.suggest(created);
      const path = `/api/revisions/${created.revision.id}/suggestions/${proposal.id}/apply`; const input = app.input(created); const key = `suggestion-lock-${phase}`;
      let replay: { key: string; fingerprint: string; status: number; body: string; created_at: string } | undefined;
      if (phase === 'replay') {
        await app.create('alice', path, input, key);
        replay = app.store.database.prepare('SELECT * FROM idempotency WHERE key LIKE ?').get(`%:${key}`) as typeof replay;
        assert.ok(replay); app.store.database.prepare('DELETE FROM idempotency WHERE key = ?').run(replay.key);
      }
      const before = app.store.detail(created.revision.id);
      const policy = (await app.request<ObjectAccess>('alice', `/api/policies/${created.revision.id}`)).body.policy;
      const restricted = { ...policy, version: policy.version + 1, rules: { view: selected(app.bob.id), edit: selected(app.bob.id), interact: selected(app.bob.id) } };
      const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(`
        import { parentPort, workerData } from 'node:worker_threads';
        import { DatabaseSync } from 'node:sqlite';
        const database = new DatabaseSync(workerData.databasePath); database.exec('PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE');
        database.prepare('UPDATE object_policies SET data = ? WHERE object_id = ?').run(JSON.stringify(workerData.policy), workerData.policy.objectId);
        database.prepare("UPDATE policy_meta SET value = value + 1 WHERE name = 'epoch'").run();
        if (workerData.replay) { const r = workerData.replay; database.prepare('INSERT INTO idempotency (key, fingerprint, status, body, created_at) VALUES (?, ?, ?, ?, ?)').run(r.key, r.fingerprint, r.status, r.body, r.created_at); }
        parentPort.once('message', () => { database.exec('COMMIT'); database.close(); parentPort.close(); }); parentPort.postMessage('locked');
      `)}`), { workerData: { databasePath, policy: restricted, replay } });
      try {
        assert.deepEqual(await once(worker, 'message'), ['locked']); let entered = 0;
        app.store.transaction = function<T>(work: () => T): T { entered++; app.store.transaction = transaction; worker.postMessage('commit'); return transaction(work); };
        const denied = await app.request('alice', path, 'POST', input, key);
        assert.equal(entered, 1); assert.equal(denied.status, 404); assert.equal(denied.body.code, 'OBJECT_UNAVAILABLE');
        const after = app.store.detail(created.revision.id);
        assert.deepEqual(after.versions, before.versions); assert.deepEqual(after.suggestionApplications, before.suggestionApplications);
        assert.deepEqual(after.threads, before.threads); assert.deepEqual(after.activity, before.activity);
      } finally { app.store.transaction = transaction; await worker.terminate(); }
    }
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('multi-passage API keeps one proposal atomic through permission checks, thread conflicts and idempotent application', async () => {
  const app = await start();
  try {
    const before = await app.create<RevisionDetail>('alice', '/api/revisions', { ...createInput, access: { spaceId: 'S1', view: workspace, edit: selected(app.alice.id), interact: workspace } });
    const version = before.versions[0]!, path = `/api/revisions/${before.revision.id}`, start = source.indexOf(quote);
    const additional = (filePath: string, quote: string, replacement: string, explanation: string) => { const start = version.files.find(file => file.path === filePath)!.content.indexOf(quote); return { anchor: createPassageAnchor(version, filePath, { start, end: start + quote.length, quote }), replacement, explanation }; };
    const suggestion = { replacement: 'fourteen days', additionalEdits: [additional('citations.bib', 'unchanged', 'updated', 'Update companion terminology.'), additional('motion.md', 'Thank you. 🧪', '', 'Remove the sign-off.')] };
    const proposed = { body: 'Revise all passages as a single change.', versionId: version.id, filePath: 'motion.md', passage: { start, end: start + quote.length, quote }, suggestion };
    const pristine = app.store.detail(before.revision.id);
    const invalid = { ...proposed, suggestion: { ...suggestion, additionalEdits: [suggestion.additionalEdits[0], { ...suggestion.additionalEdits[1], anchor: { ...suggestion.additionalEdits[1]!.anchor, prefix: 'Forged' } }] } };
    assert.equal((await app.request('bob', `${path}/comments`, 'POST', invalid)).status, 400);
    assert.deepEqual(app.store.detail(before.revision.id), pristine);
    const root = await app.create<ReviewComment>('bob', `${path}/comments`, proposed, 'multi-proposal-once');
    assert.deepEqual(root.suggestion, suggestion);
    assert.deepEqual(await app.create('bob', `${path}/comments`, proposed, 'multi-proposal-once'), root);
    const endpoint = `${path}/suggestions/${root.id}/apply`, input = app.input(before), published = app.store.detail(before.revision.id);
    assert.equal((await app.request('bob', endpoint, 'POST', input)).status, 403);
    assert.equal((await app.request('reader', endpoint, 'POST', input)).status, 403);
    assert.deepEqual(app.store.detail(before.revision.id), published);
    await app.create('bob', `${path}/threads/${root.threadId}/replies`, { body: 'Please review this complete set.', viewedVersionId: version.id });
    const replied = app.store.detail(before.revision.id);
    assert.equal((await app.request('alice', endpoint, 'POST', input)).status, 409);
    assert.equal((await app.request('alice', endpoint, 'POST', { ...input, expectedThreadVersion: 2, suggestion: { replacement: 'Untrusted patch' } })).status, 400);
    assert.deepEqual(app.store.detail(before.revision.id), replied);
    const applied = await app.create<RevisionDetail>('alice', endpoint, app.input(replied, 2), 'multi-apply-once');
    assert.deepEqual(applied.versions[0], version);
    assert.deepEqual(applied.versions[1]!.files, [{ path: 'motion.md', content: source.replace(quote, 'fourteen days').replace('Thank you. 🧪', '') }, { path: 'citations.bib', content: 'An updated companion file.\r\n' }]);
    assert.equal(applied.versions.length, 2); assert.equal(applied.suggestionApplications.length, 1); assert.equal(applied.threads[0]!.version, 3);
    assert.deepEqual(applied.comments.find(comment => comment.id === root.id), root);
    assert.deepEqual(await app.create('alice', endpoint, app.input(replied, 2), 'multi-apply-once'), applied);
    assert.equal((await app.request('alice', endpoint, 'POST', app.input(applied, 3), 'multi-again')).status, 409);
    assert.deepEqual(app.store.detail(before.revision.id).versions, applied.versions);
  } finally { await app.close(); }
});

test('an exact multi-passage proposal never rebases when source identity advances', async () => {
  const app = await start();
  try {
    const before = await app.create<RevisionDetail>('alice', '/api/revisions', createInput), version = before.versions[0]!, path = `/api/revisions/${before.revision.id}`, start = source.indexOf(quote);
    const anchor = createPassageAnchor(version, 'citations.bib', { start: 0, end: 2, quote: 'An' });
    const root = await app.create<ReviewComment>('bob', `${path}/comments`, { body: 'Update the source and companion.', versionId: version.id, filePath: 'motion.md', passage: { start, end: start + quote.length, quote }, suggestion: { replacement: 'fourteen days', additionalEdits: [{ anchor, replacement: 'The', explanation: 'Use a definite article.' }] } });
    const newer = await app.create<RevisionDetail>('alice', `${path}/versions`, { expectedVersion: 1, message: 'New immutable identity with the same text.', files: sourceFiles });
    const saved = app.store.detail(before.revision.id);
    for (const input of [app.input(before), app.input(newer)]) assert.equal((await app.request('alice', `${path}/suggestions/${root.id}/apply`, 'POST', input)).status, 409);
    assert.deepEqual(app.store.detail(before.revision.id), saved);
  } finally { await app.close(); }
});

test('large proposals publish directly or privately and apply every edit exactly once, while late invalid edits leave no effects', async () => {
  const app = await start();
  const evidence = () => Object.fromEntries(['entities', 'versions', 'comments', 'review_threads', 'thread_events', 'suggestion_applications', 'activity', 'notification_events', 'notification_deliveries', 'review_draft_sets', 'review_draft_entries', 'review_draft_operations', 'idempotency'].map(table => [table, app.store.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  try {
    for (const mode of ['direct', 'private'] as const) {
      const count = 128, perFile = 32;
      const original = Array.from({ length: count }, (_, index) => `Claim ${String(index).padStart(3, '0')}.`);
      const replacement = original.map((_, index) => index % 3 === 0 ? '' : `Qualified claim ${index} 🧪.`);
      const files = Array.from({ length: count / perFile }, (_, index) => ({ path: `part-${index}.tex`, content: original.slice(index * perFile, (index + 1) * perFile).join('\r\n') + '\r\n' }));
      const before = await app.create<RevisionDetail>('alice', '/api/revisions', { ...createInput, files });
      const version = before.versions[0]!, path = `/api/revisions/${before.revision.id}`;
      const edits = original.map((quote, index) => {
        const file = files[Math.floor(index / perFile)]!, start = file.content.indexOf(quote);
        return { anchor: createPassageAnchor(version, file.path, { start, end: start + quote.length, quote }), replacement: replacement[index]!, explanation: `Explanation ${index}: ${'Precise retained reasoning. '.repeat(40)}` };
      });
      const first = edits[0]!, suggestion = { replacement: first.replacement, additionalEdits: edits.slice(1).reverse() };
      assert.ok(edits.reduce((total, edit) => total + edit.anchor.quote.length + edit.replacement.length + edit.explanation.length, 0) > 100_000);
      const proposed = { body: first.explanation, versionId: version.id, filePath: first.anchor.filePath, passage: { start: first.anchor.start, end: first.anchor.end, quote: first.anchor.quote }, suggestion };
      const invalid = { ...proposed, suggestion: { ...suggestion, additionalEdits: [...suggestion.additionalEdits.slice(0, -1), { ...edits[1]!, anchor: { ...edits[1]!.anchor, suffix: 'Forged final context' } }] } };
      const pristine = evidence();
      let root: ReviewComment;
      if (mode === 'direct') {
        assert.equal((await app.request('bob', `${path}/comments`, 'POST', invalid, 'large-invalid-direct')).status, 400);
        assert.deepEqual(evidence(), pristine);
        root = await app.create<ReviewComment>('bob', `${path}/comments`, proposed, 'large-direct-proposal');
        assert.deepEqual(await app.create('bob', `${path}/comments`, proposed, 'large-direct-proposal'), root);
      } else {
        const entryPath = `${path}/review-drafts/${crypto.randomUUID()}`;
        const input = { expectedEntryVersion: 0, expectedAccessEpoch: app.policies.epoch(), payload: { kind: 'comment', ...proposed, contentHash: version.contentHash, line: 1 } };
        assert.equal((await app.request('bob', entryPath, 'PUT', { ...input, payload: { ...input.payload, suggestion: invalid.suggestion } }, 'large-invalid-private')).status, 400);
        assert.deepEqual(evidence(), pristine);
        const saved = await app.request<ReviewDraftChangeReceipt>('bob', entryPath, 'PUT', input, 'large-private-save');
        assert.equal(saved.status, 200, JSON.stringify(saved.body));
        assert.deepEqual(saved.body.entry.payload, input.payload);
        assert.deepEqual(await app.request('bob', entryPath, 'PUT', input, 'large-private-save'), saved);
        const preview = await app.request<ReviewDraftPreview>('bob', `${path}/review-drafts/preview`);
        assert.equal(preview.status, 200); assert.deepEqual(preview.body.entries[0]!.payload, input.payload);
        const publication = await app.request<ReviewDraftPublicationReceipt>('bob', `${path}/review-drafts/publish`, 'POST', { manifest: preview.body.manifest }, 'large-private-publish');
        assert.equal(publication.status, 200, JSON.stringify(publication.body));
        assert.equal(publication.body.published.length, 1);
        root = publication.body.published[0]!.comment;
        assert.deepEqual(await app.request('bob', `${path}/review-drafts/publish`, 'POST', { manifest: preview.body.manifest }, 'large-private-publish'), publication);
      }
      assert.deepEqual(root.suggestion, suggestion);
      const published = app.store.detail(before.revision.id);
      assert.equal(published.versions.length, 1); assert.equal(published.comments.length, 1);
      const endpoint = `${path}/suggestions/${root.id}/apply`, input = app.input(before);
      const applied = await app.create<RevisionDetail>('alice', endpoint, input, `large-${mode}-apply`);
      assert.deepEqual(applied.versions[0], version);
      assert.deepEqual(applied.versions[1]!.files, files.map((file, index) => ({ path: file.path, content: replacement.slice(index * perFile, (index + 1) * perFile).join('\r\n') + '\r\n' })));
      assert.equal(applied.versions.length, 2); assert.equal(applied.suggestionApplications.length, 1);
      assert.equal(applied.threads[0]!.version, 2); assert.deepEqual(applied.comments, [root]);
      const final = evidence();
      assert.deepEqual(await app.create('alice', endpoint, input, `large-${mode}-apply`), applied);
      assert.deepEqual(evidence(), final);
      assert.equal((await app.request('alice', endpoint, 'POST', input, `large-${mode}-again`)).status, 409);
      assert.deepEqual(evidence(), final);
    }
  } finally { await app.close(); }
});
