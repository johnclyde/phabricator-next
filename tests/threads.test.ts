import { lifecycleAction } from './revision-lifecycle-fixture.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IncomingMessage } from 'node:http';
import { Store, contentHash } from '../server/store.ts';
import { initializePolicies, PolicyStore } from '../server/policy.ts';
import { createAuth } from '../server/auth.ts';
import { AccessLayer } from '../server/access.ts';
import type { ActorAttribution, Revision, RevisionDetail, RevisionVersion, ReviewComment } from '../shared/types.ts';

const actor: ActorAttribution = { principalId: 'alice', displayName: 'Alice Writer', credentialId: 'alice-token', requestId: 'root-request' };
const responder: ActorAttribution = { principalId: 'bob', displayName: 'Bob Reviewer', credentialId: 'bob-session', requestId: 'reply-request' };
const status = (expected: number) => (error: unknown) => typeof error === 'object' && error !== null && 'status' in error && error.status === expected;
const source = 'Introduction.\nThe result needs a qualification.\nA final paragraph. 🧪\n';
const quote = 'result needs a qualification';
const passage = { start: source.indexOf(quote), end: source.indexOf(quote) + quote.length, quote };
const paper = { testPlan: 'Fixture verification plan.', title: 'A discussion paper', kind: 'paper', files: [{ path: 'main.tex', content: source }] };
const create = (store: Store) => store.createRevision(paper, actor);
const raw = (store: Store, table: string) => store.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();

test('passage roots retain immutable source identity, exact attribution and a computed location', () => {
  const store = new Store({ path: ':memory:' });
  try {
    const detail = create(store); const id = detail.revision.id; const version = detail.versions[0]!;
    const comment = store.createComment(id, { body: 'State the qualification explicitly.', versionId: version.id, filePath: 'main.tex', passage }, actor);
    assert.equal(comment.id, comment.threadId); assert.equal(comment.author, actor.displayName); assert.deepEqual(comment.attribution, actor);
    assert.equal(comment.line, 2); assert.equal(comment.versionId, version.id);
    assert.deepEqual(comment.anchor, { versionId: version.id, contentHash: version.contentHash, filePath: 'main.tex', ...passage, prefix: source.slice(0, passage.start), suffix: source.slice(passage.end) });
    const after = store.detail(id);
    assert.deepEqual(after.threads, [{ id: comment.id, rootCommentId: comment.id, revisionId: id, status: 'open', version: 1, createdAt: comment.createdAt, updatedAt: comment.createdAt }]);
    assert.deepEqual(after.threadEvents, []); assert.deepEqual(after.comments, [comment]);
    assert.deepEqual(after.versions, detail.versions); assert.deepEqual(after.revision, detail.revision);
    assert.deepEqual(after.activity[0]!.attribution, actor);
    const lineComment = store.createComment(id, { body: 'Line-only comment still works.', versionId: version.id, filePath: 'main.tex', line: 3 }, actor);
    assert.equal(lineComment.line, 3); assert.equal(lineComment.anchor, undefined);
    const general = store.createComment(id, { body: 'General discussion.', versionId: version.id }, actor);
    assert.equal(general.filePath, null); assert.equal(general.line, null); assert.equal(general.anchor, undefined);
    assert.equal(store.detail(id).threads.length, 3);
  } finally { store.close(); }
});

test('invalid passage ranges, quotes, paths, versions and inconsistent lines create no partial records', () => {
  const store = new Store({ path: ':memory:' });
  try {
    const detail = create(store); const id = detail.revision.id; const version = detail.versions[0]!;
    const foreign = create(store).versions[0]!;
    const input = { body: 'Validate every anchor.', versionId: version.id, filePath: 'main.tex', passage };
    const emoji = source.indexOf('🧪');
    const invalid = [
      { passage: null }, { passage: {} }, { passage: { ...passage, prefix: 'forged' } },
      { passage: { ...passage, start: -1 } }, { passage: { ...passage, start: 1.5 } },
      { passage: { ...passage, start: '1' } }, { passage: { ...passage, end: Number.MAX_SAFE_INTEGER + 1 } },
      { passage: { ...passage, end: source.length + 1 } }, { passage: { start: 3, end: 3, quote: '' } },
      { passage: { start: 4, end: 3, quote: '' } }, { passage: { ...passage, quote: 'A forged quote' } },
      { passage: { start: emoji, end: emoji + 1, quote: source.slice(emoji, emoji + 1) } },
      { passage: { start: emoji + 1, end: emoji + 2, quote: source.slice(emoji + 1, emoji + 2) } },
      { passage: { start: 0, end: 20_001, quote: 'x'.repeat(20_001) } },
      { filePath: null }, { filePath: 'missing.tex' }, { versionId: foreign.id }, { versionId: 'missing' },
      { line: 1 }, { line: 999 }, { line: 0 }, { anchor: { ...passage, contentHash: 'forged' } },
    ];
    const before = ['comments', 'review_threads', 'thread_events', 'activity'].map(table => raw(store, table));
    for (const changed of invalid) assert.throws(() => store.createComment(id, { ...input, ...changed }, actor), status(400), JSON.stringify(changed));
    assert.deepEqual(['comments', 'review_threads', 'thread_events', 'activity'].map(table => raw(store, table)), before);
    assert.equal(store.createComment(id, { ...input, line: 2 }, actor).line, 2);
  } finally { store.close(); }
});

test('replies inherit the original anchor and resolutions retain selected-version provenance without changing acceptance', () => {
  const store = new Store({ path: ':memory:' });
  try {
    const created = create(store); const id = created.revision.id; const first = created.versions[0]!;
    const root = store.createComment(id, { body: 'Discuss this passage.', versionId: first.id, filePath: 'main.tex', passage }, actor);
    const changed = store.createVersion(id, { expectedVersion: 1, message: 'Rework the paragraph.', files: [{ path: 'main.tex', content: 'A replacement paragraph.' }] }, actor);
    const second = changed.versions[1]!;
    store.saveReview(id, 2, { provider: 'local', model: 'deterministic', summary: 'No error findings.', findings: [] }, responder);
    lifecycleAction(store, id, 'accept_reviewed', actor);
    const before = store.detail(id);
    const reply = store.createReply(id, root.id, { body: 'Addressed in the revision I am viewing.', viewedVersionId: second.id }, responder);
    assert.equal(reply.threadId, root.id); assert.equal(reply.versionId, first.id); assert.equal(reply.viewedVersionId, second.id);
    assert.equal(reply.filePath, root.filePath); assert.equal(reply.line, root.line); assert.deepEqual(reply.anchor, root.anchor);
    assert.equal(reply.author, responder.displayName); assert.deepEqual(reply.attribution, responder);
    assert.equal(store.detail(id).threads[0]!.version, 2);
    const resolved = store.updateThread(id, root.id, { status: 'resolved', expectedThreadVersion: 2, versionId: first.id }, actor);
    assert.equal(resolved.version, 3); assert.equal(resolved.status, 'resolved');
    const resolution = store.detail(id).threadEvents[0]!;
    assert.equal(resolution.action, 'resolved'); assert.equal(resolution.threadVersion, 3); assert.equal(resolution.versionId, first.id);
    assert.equal(resolution.threadId, root.id); assert.equal(resolution.actor, actor.displayName); assert.deepEqual(resolution.attribution, actor);
    const late = store.createReply(id, root.id, { body: 'A reply after resolution.', viewedVersionId: second.id }, responder);
    assert.equal(store.detail(id).threads[0]!.status, 'resolved', 'replying never silently reopens a resolved discussion');
    assert.equal(store.detail(id).threads[0]!.version, 4);
    assert.deepEqual(store.detail(id).revision, before.revision); assert.deepEqual(store.detail(id).reviews, before.reviews); assert.deepEqual(store.detail(id).versions, before.versions);
    store.createVersion(id, { expectedVersion: 2, message: 'A separate source edit.', files: [{ path: 'main.tex', content: 'Third source version.' }] }, actor);
    assert.equal(store.detail(id).threads[0]!.status, 'resolved', 'source changes preserve the explicit discussion state');
    assert.equal(store.detail(id).revision.status, 'needs_review', 'existing source-edit acceptance invalidation is unchanged');
    const reopened = store.updateThread(id, root.id, { status: 'open', expectedThreadVersion: 4, versionId: second.id }, responder);
    assert.equal(reopened.version, 5);
    const after = store.detail(id);
    assert.deepEqual(after.comments, [root, reply, late]);
    assert.deepEqual(after.threadEvents.map(event => [event.action, event.versionId, event.threadVersion]), [['resolved', first.id, 3], ['reopened', second.id, 5]]);
    assert.deepEqual(after.threadEvents[1]!.attribution, responder);
    assert.throws(() => store.updateThread(id, root.id, { status: 'open', expectedThreadVersion: 5, versionId: first.id }, actor), status(409));
    assert.equal(store.detail(id).threadEvents.length, 2);
  } finally { store.close(); }
});

test('thread endpoints reject foreign discussions and versions without modifying either revision', () => {
  const store = new Store({ path: ':memory:' });
  try {
    const first = create(store); const second = create(store);
    const root = store.createComment(first.revision.id, { body: 'First revision only.', versionId: first.versions[0]!.id }, actor);
    const current = store.detail(first.revision.id);
    for (const threadId of [root.id, 'missing-thread']) {
      assert.throws(() => store.createReply(second.revision.id, threadId, { body: 'Foreign reply.', viewedVersionId: second.versions[0]!.id }, responder), { status: 404, code: 'THREAD_UNAVAILABLE', message: 'Discussion thread was not found.' });
      assert.throws(() => store.updateThread(second.revision.id, threadId, { status: 'resolved', expectedThreadVersion: 1, versionId: second.versions[0]!.id }, responder), { status: 404, code: 'THREAD_UNAVAILABLE', message: 'Discussion thread was not found.' });
    }
    const id = first.revision.id;
    for (const versionId of [second.versions[0]!.id, 'missing']) {
      assert.throws(() => store.createReply(id, root.id, { body: 'Foreign version.', viewedVersionId: versionId }, responder), status(400));
      assert.throws(() => store.updateThread(id, root.id, { status: 'resolved', expectedThreadVersion: 1, versionId }, actor), status(400));
    }
    assert.throws(() => store.createReply(id, root.id, { body: 'Forged source.', viewedVersionId: first.versions[0]!.id, versionId: second.versions[0]!.id }, responder), status(400));
    assert.throws(() => store.createReply(id, root.id, { body: ' ', viewedVersionId: first.versions[0]!.id }, responder), status(400));
    assert.throws(() => store.updateThread(id, root.id, { status: 'resolved', expectedThreadVersion: 1, versionId: first.versions[0]!.id, actor: 'Someone else' }, actor), status(400));
    assert.deepEqual(store.detail(id), current); assert.deepEqual(store.detail(second.revision.id), second);
  } finally { store.close(); }
});

test('unseen replies and competing state changes conflict using the current thread version across connections', () => {
  const directory = mkdtempSync(join(tmpdir(), 'phab-thread-concurrency-')); const path = join(directory, 'workspace.sqlite');
  const first = new Store({ path }); const second = new Store({ path });
  try {
    const detail = create(first); const id = detail.revision.id; const versionId = detail.versions[0]!.id;
    const root = first.createComment(id, { body: 'A concurrent discussion.', versionId }, actor);
    const staleVersion = first.detail(id).threads[0]!.version;
    second.createReply(id, root.id, { body: 'An unseen reply.', viewedVersionId: versionId }, responder);
    assert.throws(() => first.updateThread(id, root.id, { status: 'resolved', expectedThreadVersion: staleVersion, versionId }, actor), status(409));
    assert.equal(first.detail(id).threads[0]!.status, 'open'); assert.equal(first.detail(id).threadEvents.length, 0);
    first.updateThread(id, root.id, { status: 'resolved', expectedThreadVersion: 2, versionId }, actor);
    assert.throws(() => second.updateThread(id, root.id, { status: 'resolved', expectedThreadVersion: 2, versionId }, responder), status(409));
    assert.equal(first.detail(id).threadEvents.length, 1);
    second.createReply(id, root.id, { body: 'Still no implicit reopening.', viewedVersionId: versionId }, responder);
    assert.equal(first.detail(id).threads[0]!.status, 'resolved'); assert.equal(first.detail(id).threads[0]!.version, 4);
  } finally { second.close(); first.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('thread writes and activity roll back together and saved comments/events are immutable', () => {
  const store = new Store({ path: ':memory:' });
  try {
    const detail = create(store); const id = detail.revision.id; const versionId = detail.versions[0]!.id;
    const tables = ['comments', 'review_threads', 'thread_events', 'activity'];
    const beforeRoot = tables.map(table => raw(store, table));
    store.database.exec("CREATE TRIGGER fail_comment_activity BEFORE INSERT ON activity WHEN json_extract(NEW.data, '$.action') = 'commented' BEGIN SELECT RAISE(ABORT, 'Injected comment activity failure'); END;");
    assert.throws(() => store.createComment(id, { body: 'No partial root.', versionId }, actor), /Injected comment activity failure/);
    assert.deepEqual(tables.map(table => raw(store, table)), beforeRoot);
    store.database.exec('DROP TRIGGER fail_comment_activity');
    const root = store.createComment(id, { body: 'Committed root.', versionId }, actor);
    const beforeReply = tables.map(table => raw(store, table));
    store.database.exec("CREATE TRIGGER fail_reply_activity BEFORE INSERT ON activity WHEN json_extract(NEW.data, '$.action') = 'replied' BEGIN SELECT RAISE(ABORT, 'Injected reply activity failure'); END;");
    assert.throws(() => store.createReply(id, root.id, { body: 'No partial reply.', viewedVersionId: versionId }, responder), /Injected reply activity failure/);
    assert.deepEqual(tables.map(table => raw(store, table)), beforeReply);
    store.database.exec('DROP TRIGGER fail_reply_activity');
    store.database.exec("CREATE TRIGGER fail_thread_event BEFORE INSERT ON thread_events BEGIN SELECT RAISE(ABORT, 'Injected thread event failure'); END;");
    assert.throws(() => store.updateThread(id, root.id, { status: 'resolved', expectedThreadVersion: 1, versionId }, actor), /Injected thread event failure/);
    assert.deepEqual(tables.map(table => raw(store, table)), beforeReply);
    store.database.exec('DROP TRIGGER fail_thread_event');
    store.transaction(() => {
      store.createReply(id, root.id, { body: 'Nested transaction.', viewedVersionId: versionId }, responder);
      store.updateThread(id, root.id, { status: 'resolved', expectedThreadVersion: 2, versionId }, actor);
    });
    for (const table of ['comments', 'thread_events']) {
      assert.throws(() => store.database.prepare(`UPDATE ${table} SET data = data`).run(), /immutable/);
      assert.throws(() => store.database.prepare(`DELETE FROM ${table}`).run(), /immutable/);
    }
  } finally { store.close(); }
});

function legacyDatabase(path: string): { revision: Revision; version: RevisionVersion; comments: ReviewComment[]; commentJson: string[] } {
  const database = new DatabaseSync(path);
  const now = '2021-06-01T12:00:00.000Z';
  const revision: Revision = { id: 'P1', kind: 'paper', title: 'Legacy paper', summary: '', status: 'needs_review', projectId: null, repositoryId: null, currentVersion: 1, createdAt: now, updatedAt: now };
  const version: RevisionVersion = { id: 'legacy-version', revisionId: revision.id, number: 1, files: paper.files, message: 'Imported history', contentHash: contentHash(paper.files), createdAt: now };
  const comments: ReviewComment[] = [
    { id: 'legacy-line-comment', revisionId: revision.id, versionId: version.id, filePath: 'main.tex', line: 2, body: 'Legacy wording.', author: 'Unverified historical author', createdAt: now },
    { id: 'attributed-general-comment', revisionId: revision.id, versionId: version.id, filePath: null, line: null, body: 'Newer verified discussion.', author: actor.displayName, attribution: actor, createdAt: '2026-10-01T12:00:00.000Z' },
  ];
  const commentJson = comments.map(comment => JSON.stringify(comment, null, 2));
  try {
    // Build the historical schema directly: this is not a current database
    // relabelled as an older version, and its comment JSON is never rewritten.
    database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE entities (id TEXT PRIMARY KEY, kind TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE versions (id TEXT PRIMARY KEY, revision_id TEXT NOT NULL REFERENCES entities(id), number INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)), UNIQUE(revision_id, number));
      CREATE TABLE comments (id TEXT PRIMARY KEY, revision_id TEXT NOT NULL REFERENCES entities(id), version_id TEXT NOT NULL REFERENCES versions(id), data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE reviews (id TEXT PRIMARY KEY, revision_id TEXT NOT NULL REFERENCES entities(id), version_id TEXT NOT NULL REFERENCES versions(id), data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE activity (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, object_id TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE sequences (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE idempotency (key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, status INTEGER NOT NULL, body TEXT NOT NULL CHECK(json_valid(body)), created_at TEXT NOT NULL);
      CREATE TABLE wiki_versions (id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES entities(id), number INTEGER NOT NULL CHECK(number > 0), data TEXT NOT NULL CHECK(json_valid(data)), UNIQUE(document_id, number));
      CREATE TRIGGER wiki_versions_no_update BEFORE UPDATE ON wiki_versions BEGIN SELECT RAISE(ABORT, 'Wiki versions are immutable'); END;
      CREATE TRIGGER wiki_versions_no_delete BEFORE DELETE ON wiki_versions BEGIN SELECT RAISE(ABORT, 'Wiki versions are immutable'); END;
      INSERT INTO sequences (name, value) VALUES ('revision', 1);
    `);
    database.prepare('INSERT INTO entities (id, kind, data) VALUES (?, ?, ?)').run(revision.id, 'revision', JSON.stringify(revision));
    database.prepare('INSERT INTO versions (id, revision_id, number, data) VALUES (?, ?, ?, ?)').run(version.id, revision.id, 1, JSON.stringify(version));
    comments.forEach((comment, index) => database.prepare('INSERT INTO comments (id, revision_id, version_id, data) VALUES (?, ?, ?, ?)').run(comment.id, revision.id, version.id, commentJson[index]!));
    database.prepare('INSERT INTO idempotency (key, fingerprint, status, body, created_at) VALUES (?, ?, ?, ?, ?)').run('legacy-comment-replay', 'legacy-fingerprint', 201, commentJson[0]!, now);
    initializePolicies(database); database.exec('PRAGMA user_version = 4');
    return { revision, version, comments, commentJson };
  } finally { database.close(); }
}

test('schema 4 migration preserves legacy comment bytes, provenance and replay while adding persistent one-message threads', () => {
  const directory = mkdtempSync(join(tmpdir(), 'phab-thread-migration-')); const path = join(directory, 'workspace.sqlite');
  const legacy = legacyDatabase(path); let store = new Store({ path });
  try {
    assert.equal(store.fresh, false); assert.equal((store.database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 30);
    const detail = store.detail(legacy.revision.id);
    assert.deepEqual(detail.revision, { ...legacy.revision, authorId: null, authorDisplayName: null, authorVersion: 0, lifecycleVersion: 0, reviewerVersion: 0, metadataVersion: 0, testPlan: null, projectIds: [], projectVersion: 0 }); assert.deepEqual(detail.versions, [legacy.version]); assert.deepEqual(detail.comments, legacy.comments);
    assert.deepEqual((raw(store, 'comments') as { data: string }[]).map(row => row.data), legacy.commentJson);
    assert.equal(detail.comments[0]!.attribution, undefined); assert.equal(detail.comments[0]!.threadId, undefined);
    assert.equal(detail.comments[0]!.anchor, undefined);
    assert.deepEqual(detail.threads, legacy.comments.map(comment => ({ id: comment.id, rootCommentId: comment.id, revisionId: comment.revisionId, status: 'open', version: 1, createdAt: comment.createdAt, updatedAt: comment.createdAt })));
    assert.deepEqual(detail.threadEvents, []); assert.deepEqual(detail.activity, []);
    assert.deepEqual(store.replay('legacy-comment-replay', 'legacy-fingerprint'), { status: 201, body: legacy.comments[0] });
    const thread = detail.threads[0]!;
    const replyInput = { body: 'Reply to the original line.', viewedVersionId: legacy.version.id };
    const reply = store.mutate('reply-once', 'reply-fingerprint', () => ({ status: 201, body: store.createReply(legacy.revision.id, thread.id, replyInput, responder) }));
    const resolved = store.mutate('resolve-once', 'resolve-fingerprint', () => ({ status: 200, body: store.updateThread(legacy.revision.id, thread.id, { status: 'resolved', expectedThreadVersion: 2, versionId: legacy.version.id }, actor) }));
    const before = store.detail(legacy.revision.id);
    assert.equal(before.comments[2]!.versionId, legacy.version.id); assert.equal(before.comments[2]!.line, 2); assert.equal(before.comments[2]!.anchor, undefined);
    store.close(); store = new Store({ path });
    assert.deepEqual(store.detail(legacy.revision.id), before);
    assert.deepEqual(store.mutate('reply-once', 'reply-fingerprint', () => { throw new Error('Must not repeat reply'); }), reply);
    assert.deepEqual(store.mutate('resolve-once', 'resolve-fingerprint', () => { throw new Error('Must not repeat resolution'); }), resolved);
    assert.throws(() => store.mutate('reply-once', 'different-fingerprint', () => ({ status: 201, body: {} })), status(409));
    store.updateThread(legacy.revision.id, thread.id, { status: 'open', expectedThreadVersion: 3, versionId: legacy.version.id }, responder);
    assert.equal(store.detail(legacy.revision.id).threads[0]!.status, 'open');
    assert.deepEqual(store.detail(legacy.revision.id).comments.slice(0, 2), legacy.comments);
    assert.deepEqual((raw(store, 'comments') as { data: string }[]).slice(0, 2).map(row => row.data), legacy.commentJson);
    assert.deepEqual(store.detail(legacy.revision.id).versions, [legacy.version]);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('legacy replay presentation adds only historical thread shape without rewriting stored JSON or borrowing current state', () => {
  const directory = mkdtempSync(join(tmpdir(), 'phab-thread-replay-shape-')); const path = join(directory, 'workspace.sqlite');
  const legacy = legacyDatabase(path); const store = new Store({ path });
  try {
    const auth = createAuth({ database: store.database, mode: 'local', basePath: '/' });
    const context = auth.authenticate({ method: 'GET', headers: {} } as IncomingMessage);
    const policies = new PolicyStore(store.database, { principalExists: id => id === context.principalId });
    const access = new AccessLayer(store, auth, policies, context);
    const { threads: _threads, threadEvents: _events, suggestionApplications: _applications, ...historical } = store.detail(legacy.revision.id);
    const body = JSON.stringify(historical, null, 2);
    store.database.prepare('INSERT INTO idempotency (key, fingerprint, status, body, created_at) VALUES (?, ?, ?, ?, ?)').run('legacy-detail-replay', 'legacy-detail-fingerprint', 201, body, legacy.version.createdAt);
    const root = legacy.comments[0]!;
    store.createReply(legacy.revision.id, root.id, { body: 'A later reply must not enter the old response.', viewedVersionId: legacy.version.id }, responder);
    store.updateThread(legacy.revision.id, root.id, { status: 'resolved', expectedThreadVersion: 2, versionId: legacy.version.id }, actor);
    const response = store.mutate('legacy-detail-replay', 'legacy-detail-fingerprint', () => { throw new Error('Historical mutation must not run again'); }, undefined,
      saved => access.present('POST', `/api/revisions/${legacy.revision.id}/versions`, saved));
    const displayed = response.body as RevisionDetail;
    assert.deepEqual(displayed.threads, legacy.comments.map(comment => ({ id: comment.id, revisionId: comment.revisionId, rootCommentId: comment.id, status: 'open', version: 1, createdAt: comment.createdAt, updatedAt: comment.createdAt })));
    assert.deepEqual(displayed.threadEvents, []); assert.deepEqual(displayed.comments, legacy.comments); assert.deepEqual(displayed.versions, [legacy.version]);
    assert.equal(displayed.comments[0]!.attribution, undefined);
    assert.deepEqual(displayed.access, access.describe(legacy.revision.id));
    assert.equal(store.detail(legacy.revision.id).threads[0]!.status, 'resolved');
    assert.equal(store.detail(legacy.revision.id).threads[0]!.version, 3);
    assert.throws(() => store.updateThread(legacy.revision.id, root.id, { status: 'resolved', expectedThreadVersion: displayed.threads[0]!.version, versionId: legacy.version.id }, actor), status(409));
    assert.equal((store.database.prepare('SELECT body FROM idempotency WHERE key = ?').get('legacy-detail-replay') as { body: string }).body, body);
    assert.deepEqual(store.replay('legacy-detail-replay', 'legacy-detail-fingerprint')!.body, historical);
    for (const comment of [
      { ...root, threadId: root.id }, { ...root, viewedVersionId: legacy.version.id },
      { ...root, createdAt: 'not a timestamp' }, { ...root, versionId: 'unknown-version' },
    ]) assert.throws(() => access.present('POST', `/api/revisions/${legacy.revision.id}/versions`, { status: 201, body: { ...historical, comments: [comment] } }), status(409));
    assert.throws(() => access.present('POST', `/api/revisions/${legacy.revision.id}/versions`, { status: 201, body: { ...historical, comments: [root, root] } }), status(409));
    assert.throws(() => access.present('POST', `/api/revisions/${legacy.revision.id}/versions`, { status: 201, body: { ...historical, threadEvents: [{ action: 'resolved' }] } }), status(409));
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
