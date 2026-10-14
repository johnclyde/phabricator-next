import { lifecycleAction } from './revision-lifecycle-fixture.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IncomingMessage } from 'node:http';
import { Store, contentHash } from '../server/store.ts';
import { AccessLayer } from '../server/access.ts';
import { createAuth } from '../server/auth.ts';
import { initializePolicies, PolicyStore } from '../server/policy.ts';
import { createPassageAnchor } from '../shared/anchors.ts';
import type { ActorAttribution, ApplySuggestionInput, Revision, RevisionDetail, RevisionVersion, ReviewComment, ReviewThread, ReviewThreadEvent, SourceFile } from '../shared/types.ts';

const author: ActorAttribution = { principalId: 'writer', displayName: 'Writer', credentialId: 'writer-session', requestId: 'apply-request' };
const reviewer: ActorAttribution = { principalId: 'reviewer', displayName: 'Reviewer', credentialId: 'reviewer-token', requestId: 'proposal-request' };
const source = 'Introduction.\r\nThe result needs a qualification.\r\nFinal paragraph. 🧪\n';
const quote = 'result needs a qualification';
const passage = { start: source.indexOf(quote), end: source.indexOf(quote) + quote.length, quote };
const replacement = 'result holds under the stated assumptions';
const sourceFiles = [{ path: 'main.tex', content: source }, { path: 'appendix.tex', content: '  Unchanged appendix.\r\n' }];
const create = (store: Store, files: SourceFile[] = sourceFiles) => store.createRevision({ testPlan: 'Fixture verification plan.', title: 'A proposed correction', kind: 'paper', files }, author);
const proposal = (store: Store, detail: RevisionDetail) => store.createComment(detail.revision.id, {
  body: 'State the assumptions explicitly.', versionId: detail.versions[0]!.id, filePath: 'main.tex', passage, suggestion: { replacement },
}, reviewer);
const expected = (detail: RevisionDetail, threadId: string): ApplySuggestionInput => {
  const version = detail.versions.find(item => item.number === detail.revision.currentVersion)!;
  return { expectedVersion: version.number, expectedVersionId: version.id, expectedContentHash: version.contentHash, expectedThreadVersion: detail.threads.find(thread => thread.id === threadId)!.version };
};
const status = (expectedStatus: number) => (error: unknown) => typeof error === 'object' && error !== null && 'status' in error && error.status === expectedStatus;
const tables = ['entities', 'versions', 'comments', 'review_threads', 'thread_events', 'suggestion_applications', 'reviews', 'activity', 'idempotency'];
const raw = (store: Store, table: string) => store.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
const snapshot = (store: Store) => tables.map(table => raw(store, table));

test('applying a stored proposal creates exact new source, invalidates acceptance and preserves resolved discussion and prior evidence', () => {
  const store = new Store({ path: ':memory:' });
  try {
    const created = create(store); const id = created.revision.id; const first = created.versions[0]!;
    const comment = proposal(store, created);
    assert.deepEqual(comment.suggestion, { replacement }); assert.deepEqual(comment.attribution, reviewer);
    store.updateThread(id, comment.id, { status: 'resolved', expectedThreadVersion: 1, versionId: first.id }, reviewer);
    store.saveReview(id, 1, { provider: 'local', model: 'deterministic', summary: 'No blocking findings.', findings: [] }, author);
    lifecycleAction(store, id, 'accept_reviewed', author);
    const before = store.detail(id); const versionJson = (raw(store, 'versions')[0] as { data: string }).data;
    const applied = store.applySuggestion(id, comment.id, expected(before, comment.id), author);
    assert.equal(applied.revision.currentVersion, 2); assert.equal(applied.revision.status, 'needs_review');
    assert.deepEqual(applied.versions[0], first); assert.equal((raw(store, 'versions')[0] as { data: string }).data, versionJson);
    assert.deepEqual(applied.versions[1]!.files, [{ path: 'main.tex', content: source.slice(0, passage.start) + replacement + source.slice(passage.end) }, sourceFiles[1]]);
    assert.deepEqual(applied.versions[1]!.attribution, author); assert.deepEqual(applied.comments, before.comments);
    assert.deepEqual(applied.reviews, before.reviews); assert.deepEqual(applied.threadEvents, before.threadEvents);
    assert.equal(applied.threads[0]!.status, 'resolved'); assert.equal(applied.threads[0]!.version, 3);
    const application = applied.suggestionApplications[0]!;
    assert.equal(applied.suggestionApplications.length, 1);
    assert.deepEqual({ ...application, id: 'generated', createdAt: 'generated' }, {
      id: 'generated', revisionId: id, commentId: comment.id, threadId: comment.id,
      fromVersionId: first.id, toVersionId: applied.versions[1]!.id,
      fromContentHash: contentHash(first.files), toContentHash: contentHash(applied.versions[1]!.files),
      threadVersion: 3, actor: author.displayName, attribution: author, createdAt: 'generated',
    });
    assert.equal(application.createdAt, applied.threads[0]!.updatedAt);
    assert.equal(applied.activity[0]!.action, 'suggestion_applied'); assert.deepEqual(applied.activity[0]!.attribution, author);
    assert.match(applied.activity[0]!.detail, /from version 1 as version 2/);
    assert.equal(applied.activity.filter(item => item.action === 'reviewed').length, 1, 'applying never runs another review');
    const after = snapshot(store);
    assert.throws(() => store.applySuggestion(id, comment.id, expected(applied, comment.id), author), status(409));
    assert.deepEqual(snapshot(store), after);
    assert.throws(() => store.database.exec('UPDATE suggestion_applications SET data = data'), /immutable/);
    assert.throws(() => store.database.exec('DELETE FROM suggestion_applications'), /immutable/);
    const row = raw(store, 'suggestion_applications')[0] as Record<string, string>;
    assert.throws(() => store.database.prepare('INSERT INTO suggestion_applications (id, revision_id, comment_id, thread_id, from_version_id, to_version_id, data) VALUES (?, ?, ?, ?, ?, ?, ?)').run('duplicate', row.revision_id!, row.comment_id!, row.thread_id!, row.from_version_id!, row.to_version_id!, row.data!), /UNIQUE constraint failed: suggestion_applications.comment_id/);
  } finally { store.close(); }
});

test('proposals require an explanatory root with a validated passage and strict replacement text; replies cannot add or inherit a proposal', () => {
  const store = new Store({ path: ':memory:' });
  try {
    const detail = create(store); const id = detail.revision.id; const versionId = detail.versions[0]!.id;
    const input = { body: 'Explain this change.', versionId, filePath: 'main.tex', passage, suggestion: { replacement } };
    const invalid = [
      { suggestion: null }, { suggestion: {} }, { suggestion: [] }, { suggestion: { replacement: 1 } },
      { suggestion: { replacement, extra: true } }, { suggestion: { replacement: quote } },
      { suggestion: { replacement: 'x'.repeat(20_001) } }, { suggestion: { replacement: '\0' } },
      { suggestion: { replacement: '\ud800' } }, { suggestion: { replacement: '\udc00' } },
      { passage: undefined }, { passage: { ...passage, quote: 'A forged original' } },
      { body: '' }, { body: '  ' }, { threadId: 'existing-thread' }, { viewedVersionId: versionId },
    ];
    const before = snapshot(store);
    for (const changed of invalid) assert.throws(() => store.createComment(id, { ...input, ...changed }, reviewer), status(400), JSON.stringify(changed));
    assert.deepEqual(snapshot(store), before);
    const root = store.createComment(id, input, reviewer);
    assert.throws(() => store.createReply(id, root.id, { body: 'Cannot amend the proposal.', viewedVersionId: versionId, suggestion: { replacement: 'Other text' } }, author), status(400));
    const reply = store.createReply(id, root.id, { body: 'The explanation is helpful.', viewedVersionId: versionId }, author);
    assert.deepEqual(reply.anchor, root.anchor); assert.equal(reply.suggestion, undefined);
    const deleted = store.createComment(id, { ...input, suggestion: { replacement: '' } }, reviewer);
    const after = store.applySuggestion(id, deleted.id, expected(store.detail(id), deleted.id), author);
    assert.equal(after.versions[1]!.files[0]!.content, source.slice(0, passage.start) + source.slice(passage.end));
    assert.equal(after.threads.find(thread => thread.id === deleted.id)!.status, 'open');
  } finally { store.close(); }
});

test('missing, foreign and nonproposal children are indistinguishable without invalidating the parent; apply payload cannot supply a patch', () => {
  const store = new Store({ path: ':memory:' });
  try {
    const first = create(store); const second = create(store); const root = proposal(store, first);
    const ordinary = store.createComment(first.revision.id, { body: 'No replacement.', versionId: first.versions[0]!.id }, reviewer);
    const reply = store.createReply(first.revision.id, root.id, { body: 'A reply.', viewedVersionId: first.versions[0]!.id }, author);
    for (const [id, commentId] of [[first.revision.id, 'missing'], [second.revision.id, root.id], [first.revision.id, ordinary.id], [first.revision.id, reply.id]]) {
      assert.throws(() => store.applySuggestion(id!, commentId!, {}, author), { status: 404, code: 'SUGGESTION_UNAVAILABLE', message: 'Suggested replacement was not found.' });
    }
    const input = expected(store.detail(first.revision.id), root.id); const before = snapshot(store);
    for (const changed of [
      { replacement: 'Untrusted patch' }, { files: sourceFiles }, { expectedVersion: 0 }, { expectedVersionId: '' },
      { expectedContentHash: 'not-a-digest' }, { expectedContentHash: undefined }, { expectedThreadVersion: 0 },
    ]) assert.throws(() => store.applySuggestion(first.revision.id, root.id, { ...input, ...changed }, author), status(400));
    for (const changed of [
      { expectedVersion: 2 }, { expectedVersionId: second.versions[0]!.id }, { expectedContentHash: '0'.repeat(64) }, { expectedThreadVersion: 1 },
    ]) assert.throws(() => store.applySuggestion(first.revision.id, root.id, { ...input, ...changed }, author), status(409));
    assert.deepEqual(snapshot(store), before);
  } finally { store.close(); }
});

test('unseen replies or resolutions conflict across connections, and every newer source version makes an unapplied original proposal stale', () => {
  const directory = mkdtempSync(join(tmpdir(), 'phab-suggestion-concurrency-')); const path = join(directory, 'workspace.sqlite');
  const first = new Store({ path }); const second = new Store({ path });
  try {
    const detail = create(first); const id = detail.revision.id; const root = proposal(first, detail);
    const initial = expected(first.detail(id), root.id);
    second.createReply(id, root.id, { body: 'An unseen reply.', viewedVersionId: initial.expectedVersionId }, reviewer);
    assert.throws(() => first.applySuggestion(id, root.id, initial, author), status(409));
    const replied = expected(first.detail(id), root.id);
    second.updateThread(id, root.id, { status: 'resolved', expectedThreadVersion: replied.expectedThreadVersion, versionId: initial.expectedVersionId }, reviewer);
    assert.throws(() => first.applySuggestion(id, root.id, replied, author), status(409));
    const resolved = expected(first.detail(id), root.id);
    second.createVersion(id, { expectedVersion: 1, message: 'Same source, new immutable identity.', files: sourceFiles }, author);
    assert.throws(() => first.applySuggestion(id, root.id, resolved, author), status(409));
    assert.throws(() => first.applySuggestion(id, root.id, expected(first.detail(id), root.id), author), status(409), 'a fresh current-version payload cannot retarget the original proposal');
    assert.equal(first.detail(id).suggestionApplications.length, 0); assert.equal(first.detail(id).versions.length, 2);
    assert.equal(first.detail(id).threads[0]!.version, 3); assert.equal(first.detail(id).threads[0]!.status, 'resolved');
  } finally { second.close(); first.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('application recomputes the complete source hash instead of trusting saved metadata or an unchanged target quote', () => {
  const store = new Store({ path: ':memory:' });
  try {
    const detail = create(store); const id = detail.revision.id; const first = detail.versions[0]!; const root = proposal(store, detail);
    const input = expected(store.detail(id), root.id);
    // Simulate corrupt/imported source metadata while leaving the target file
    // and stored digest intact: a quote match must not authorize this write.
    const changed = { ...first, files: [first.files[0]!, { path: 'appendix.tex', content: 'Unexpected unrelated change.' }] };
    store.database.prepare('UPDATE versions SET data = ? WHERE id = ?').run(JSON.stringify(changed), first.id);
    const before = snapshot(store);
    assert.throws(() => store.applySuggestion(id, root.id, input, author), status(409));
    assert.throws(() => store.applySuggestion(id, root.id, { ...input, expectedContentHash: contentHash(changed.files) }, author), status(409));
    assert.deepEqual(snapshot(store), before);
  } finally { store.close(); }
});

test('the complete resulting source must satisfy per-file character and total UTF-8 byte limits before a write', () => {
  for (const files of [
    [{ path: 'main.tex', content: 'x'.repeat(500_000) }],
    Array.from({ length: 4 }, (_, index) => ({ path: index === 0 ? 'main.tex' : `part${index}.tex`, content: 'x'.repeat(375_000) })),
  ]) {
    const store = new Store({ path: ':memory:' });
    try {
      const detail = create(store, files); const id = detail.revision.id;
      const root = store.createComment(id, { body: 'This valid proposal produces oversized source.', versionId: detail.versions[0]!.id, filePath: 'main.tex', passage: { start: 0, end: 1, quote: 'x' }, suggestion: { replacement: files.length === 1 ? 'xx' : 'é' } }, reviewer);
      const before = snapshot(store);
      assert.throws(() => store.applySuggestion(id, root.id, expected(store.detail(id), root.id), author), status(400));
      assert.deepEqual(snapshot(store), before);
    } finally { store.close(); }
  }
});

test('source, acceptance, thread, application, activity and replay writes roll back together; a retry applies once and survives restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'phab-suggestion-atomic-')); const path = join(directory, 'workspace.sqlite');
  let store = new Store({ path });
  try {
    const detail = create(store); const id = detail.revision.id; const root = proposal(store, detail);
    store.saveReview(id, 1, { provider: 'local', model: 'deterministic', summary: 'No blockers.', findings: [] }, author);
    lifecycleAction(store, id, 'accept_reviewed', author);
    const input = expected(store.detail(id), root.id); const before = snapshot(store);
    const apply = () => store.mutate('apply-once', 'apply-fingerprint', () => ({ status: 201, body: store.applySuggestion(id, root.id, input, author) }));
    for (const trigger of [
      "CREATE TRIGGER injected_failure BEFORE INSERT ON suggestion_applications BEGIN SELECT RAISE(ABORT, 'Injected application failure'); END;",
      "CREATE TRIGGER injected_failure BEFORE INSERT ON activity WHEN json_extract(NEW.data, '$.action') = 'suggestion_applied' BEGIN SELECT RAISE(ABORT, 'Injected activity failure'); END;",
    ]) {
      store.database.exec(trigger); assert.throws(apply, /Injected/); assert.deepEqual(snapshot(store), before);
      store.database.exec('DROP TRIGGER injected_failure');
    }
    const response = apply(); const after = store.detail(id); assert.equal(after.revision.status, 'needs_review');
    store.close(); store = new Store({ path });
    assert.deepEqual(store.detail(id), after);
    assert.deepEqual(store.mutate('apply-once', 'apply-fingerprint', () => { throw new Error('Must not apply again'); }), response);
    assert.throws(() => store.mutate('apply-once', 'different-fingerprint', () => ({ status: 201, body: {} })), status(409));
    assert.throws(() => store.applySuggestion(id, root.id, input, author), status(409));
    assert.equal(store.detail(id).versions.length, 2); assert.equal(store.detail(id).suggestionApplications.length, 1);
    assert.equal(store.detail(id).threads[0]!.version, 2);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

function schemaFive(path: string): { detail: Omit<RevisionDetail, 'suggestionApplications'>; bytes: Map<string, string[]>; replay: string } {
  const db = new DatabaseSync(path); const now = '2026-10-01T12:00:00.000Z';
  const revision: Revision = { id: 'P1', kind: 'paper', title: 'Preserved discussion', summary: '', status: 'needs_review', projectId: null, repositoryId: null, currentVersion: 1, createdAt: now, updatedAt: now };
  const version: RevisionVersion = { id: 'schema-five-version', revisionId: revision.id, number: 1, files: sourceFiles, message: 'Original source', contentHash: contentHash(sourceFiles), createdAt: now };
  const root: ReviewComment = { id: 'root-five', threadId: 'root-five', revisionId: revision.id, versionId: version.id, filePath: 'main.tex', line: 2, anchor: createPassageAnchor(version, 'main.tex', passage), body: 'Original passage discussion.', author: 'Historical author', createdAt: now };
  const reply: ReviewComment = { ...root, id: 'reply-five', body: 'An attributed reply.', viewedVersionId: version.id, author: reviewer.displayName, attribution: reviewer };
  const thread: ReviewThread = { id: root.id, revisionId: revision.id, rootCommentId: root.id, status: 'resolved', version: 3, createdAt: now, updatedAt: now };
  const event: ReviewThreadEvent = { id: 'resolution-five', revisionId: revision.id, threadId: root.id, action: 'resolved', versionId: version.id, threadVersion: 3, actor: reviewer.displayName, attribution: reviewer, createdAt: now };
  const detail = { revision, versions: [version], comments: [root, reply], threads: [thread], threadEvents: [event], reviews: [], activity: [] };
  const replay = JSON.stringify(detail, null, 2); const bytes = new Map<string, string[]>();
  try {
    // This is direct historical schema 5 DDL, not a current Store relabelled.
    db.exec(`
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
      CREATE TABLE review_threads (id TEXT PRIMARY KEY, revision_id TEXT NOT NULL REFERENCES entities(id), root_comment_id TEXT NOT NULL UNIQUE REFERENCES comments(id), data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE thread_events (id TEXT PRIMARY KEY, revision_id TEXT NOT NULL REFERENCES entities(id), thread_id TEXT NOT NULL REFERENCES review_threads(id), version_id TEXT NOT NULL REFERENCES versions(id), data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TRIGGER comments_no_update BEFORE UPDATE ON comments BEGIN SELECT RAISE(ABORT, 'Review comments are immutable'); END;
      CREATE TRIGGER comments_no_delete BEFORE DELETE ON comments BEGIN SELECT RAISE(ABORT, 'Review comments are immutable'); END;
      CREATE TRIGGER thread_events_no_update BEFORE UPDATE ON thread_events BEGIN SELECT RAISE(ABORT, 'Thread events are immutable'); END;
      CREATE TRIGGER thread_events_no_delete BEFORE DELETE ON thread_events BEGIN SELECT RAISE(ABORT, 'Thread events are immutable'); END;
      INSERT INTO sequences (name, value) VALUES ('revision', 1);
    `);
    db.prepare('INSERT INTO entities (id, kind, data) VALUES (?, ?, ?)').run(revision.id, 'revision', JSON.stringify(revision, null, 2));
    db.prepare('INSERT INTO versions (id, revision_id, number, data) VALUES (?, ?, ?, ?)').run(version.id, revision.id, 1, JSON.stringify(version, null, 2));
    for (const comment of detail.comments) db.prepare('INSERT INTO comments (id, revision_id, version_id, data) VALUES (?, ?, ?, ?)').run(comment.id, revision.id, version.id, JSON.stringify(comment, null, 2));
    db.prepare('INSERT INTO review_threads (id, revision_id, root_comment_id, data) VALUES (?, ?, ?, ?)').run(thread.id, revision.id, root.id, JSON.stringify(thread, null, 2));
    db.prepare('INSERT INTO thread_events (id, revision_id, thread_id, version_id, data) VALUES (?, ?, ?, ?, ?)').run(event.id, revision.id, thread.id, version.id, JSON.stringify(event, null, 2));
    db.prepare('INSERT INTO idempotency (key, fingerprint, status, body, created_at) VALUES (?, ?, ?, ?, ?)').run('old-detail', 'old-fingerprint', 201, replay, now);
    initializePolicies(db); db.exec('PRAGMA user_version = 5');
    for (const table of ['entities', 'versions', 'comments', 'review_threads', 'thread_events']) bytes.set(table, (db.prepare(`SELECT data FROM ${table} ORDER BY rowid`).all() as { data: string }[]).map(row => row.data));
    return { detail, bytes, replay };
  } finally { db.close(); }
}

test('schema 5 migration preserves original bytes and provenance; old replay gets an empty historical application list, never current data', () => {
  const directory = mkdtempSync(join(tmpdir(), 'phab-suggestion-migration-')); const path = join(directory, 'workspace.sqlite');
  const old = schemaFive(path); const store = new Store({ path });
  try {
    assert.equal((store.database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 45);
    assert.deepEqual(store.detail('P1'), { ...old.detail, revision: { ...old.detail.revision, authorId: null, authorDisplayName: null, authorVersion: 0, lifecycleVersion: 0, reviewerVersion: 0, metadataVersion: 0, testPlan: null, projectIds: [], projectVersion: 0 }, suggestionApplications: [] });
    for (const [table, bytes] of old.bytes) assert.deepEqual((raw(store, table) as { data: string }[]).map(row => row.data), bytes);
    assert.equal(store.detail('P1').comments[0]!.attribution, undefined);
    const auth = createAuth({ database: store.database, mode: 'local', basePath: '/' });
    const context = auth.authenticate({ method: 'GET', headers: {} } as IncomingMessage);
    const access = new AccessLayer(store, auth, new PolicyStore(store.database, { principalExists: id => id === context.principalId }), context);
    const root = proposal(store, store.detail('P1'));
    store.applySuggestion('P1', root.id, expected(store.detail('P1'), root.id), author);
    const response = store.mutate('old-detail', 'old-fingerprint', () => { throw new Error('Historical write must not repeat'); }, undefined, saved => access.present('POST', '/api/revisions/P1/versions', saved));
    const presented = response.body as RevisionDetail;
    assert.deepEqual(presented.suggestionApplications, []); assert.deepEqual(presented.comments, old.detail.comments);
    assert.deepEqual(presented.threads, old.detail.threads); assert.deepEqual(presented.threadEvents, old.detail.threadEvents);
    assert.deepEqual(presented.versions, old.detail.versions); assert.equal(store.detail('P1').suggestionApplications.length, 1);
    assert.equal((store.database.prepare('SELECT body FROM idempotency WHERE key = ?').get('old-detail') as { body: string }).body, old.replay);
    assert.deepEqual(store.replay('old-detail', 'old-fingerprint')!.body, old.detail);
    assert.throws(() => access.present('POST', '/api/revisions/P1/versions', { status: 201, body: { ...old.detail, comments: [root] } }), status(409), 'a response containing proposals is not an older suggestion-free snapshot');
    assert.throws(() => access.present('POST', '/api/revisions/P1/versions', { status: 201, body: { ...old.detail, threadEvents: undefined } }), status(409));
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

function multiProposal(store: Store, detail: RevisionDetail) {
  const version = detail.versions[0]!;
  const anchored = (filePath: string, quote: string) => { const start = version.files.find(file => file.path === filePath)!.content.indexOf(quote); return createPassageAnchor(version, filePath, { start, end: start + quote.length, quote }); };
  return { body: 'Clarify the result and its companion text together.', versionId: version.id, filePath: 'main.tex', passage, suggestion: { replacement, additionalEdits: [
    { anchor: anchored('appendix.tex', 'Unchanged'), replacement: 'Revised', explanation: 'Keep the appendix consistent.' },
    { anchor: anchored('main.tex', 'Final paragraph.'), replacement: '', explanation: 'Remove the obsolete conclusion.' },
    { anchor: anchored('main.tex', 'Introduction.'), replacement: 'Expanded introduction.', explanation: 'Introduce the complete assumptions.' },
  ] } };
}

test('a multi-passage proposal creates one immutable source, application, thread advance and notification cause', () => {
  const store = new Store({ path: ':memory:' });
  try {
    store.notifications.configure({ eligible: () => true, canView: () => true });
    const detail = create(store), id = detail.revision.id, input = multiProposal(store, detail);
    const root = store.createComment(id, input, reviewer);
    assert.deepEqual(root.suggestion, input.suggestion);
    const savedComment = JSON.stringify(root);
    store.saveReview(id, 1, { provider: 'local', model: 'deterministic', summary: 'No blockers.', findings: [] }, author);
    lifecycleAction(store, id, 'accept_reviewed', author);
    const before = store.detail(id), applied = store.applySuggestion(id, root.id, expected(before, root.id), author);
    assert.equal(applied.versions.length, 2);
    assert.deepEqual(applied.versions[0], detail.versions[0]);
    assert.equal(applied.versions[1]!.files[0]!.content, source.replace(quote, replacement).replace('Final paragraph.', '').replace('Introduction.', 'Expanded introduction.'));
    assert.equal(applied.versions[1]!.files[1]!.content, '  Revised appendix.\r\n');
    assert.equal(applied.revision.status, 'needs_review');
    assert.equal(applied.suggestionApplications.length, 1);
    assert.equal(applied.threads[0]!.version, before.threads[0]!.version + 1);
    assert.equal(applied.threads[0]!.status, before.threads[0]!.status);
    assert.deepEqual(applied.threadEvents, before.threadEvents);
    assert.equal(applied.activity.filter(item => item.action === 'suggestion_applied').length, 1);
    assert.equal(JSON.stringify(applied.comments[0]), savedComment);
    assert.equal(store.database.prepare("SELECT count(*) AS n FROM notification_events WHERE json_extract(data, '$.kind') = 'suggestion_applied'").get()!.n, 1);
  } finally { store.close(); }
});

test('invalid later passages reject the whole proposal before comments, threads or activity are written', () => {
  const store = new Store({ path: ':memory:' });
  try {
    const detail = create(store), foreign = create(store), id = detail.revision.id, input = multiProposal(store, detail), before = snapshot(store);
    const valid = input.suggestion.additionalEdits;
    for (const edit of [
      { ...valid[0]!, anchor: { ...valid[0]!.anchor, suffix: 'Wrong context' } },
      { ...valid[0]!, anchor: { ...valid[0]!.anchor, versionId: foreign.versions[0]!.id } },
      { ...valid[0]!, anchor: { ...valid[0]!.anchor, contentHash: '0'.repeat(64) } },
      { ...valid[0]!, anchor: { ...valid[0]!.anchor, filePath: 'missing.tex' } },
      { ...valid[0]!, anchor: createPassageAnchor(detail.versions[0]!, 'main.tex', passage) },
      { ...valid[0]!, explanation: '' },
    ]) {
      assert.throws(() => store.createComment(id, { ...input, suggestion: { replacement, additionalEdits: [valid[1], valid[2], edit] } }, reviewer), status(400));
      assert.deepEqual(snapshot(store), before);
    }
  } finally { store.close(); }
});

test('multi-passage application rolls back every edit and evidence row, and an identical retry applies only once', () => {
  const store = new Store({ path: ':memory:' });
  try {
    const detail = create(store), id = detail.revision.id, root = store.createComment(id, multiProposal(store, detail), reviewer);
    const input = expected(store.detail(id), root.id), before = snapshot(store);
    const apply = () => store.mutate('batch-apply', 'batch-fingerprint', () => ({ status: 201, body: store.applySuggestion(id, root.id, input, author) }));
    store.database.exec("CREATE TRIGGER fail_batch BEFORE INSERT ON suggestion_applications BEGIN SELECT RAISE(ABORT, 'batch failure'); END");
    assert.throws(apply, /batch failure/); assert.deepEqual(snapshot(store), before);
    store.database.exec('DROP TRIGGER fail_batch');
    const result = apply(), after = snapshot(store);
    assert.deepEqual(apply(), result); assert.deepEqual(snapshot(store), after);
    assert.throws(() => store.applySuggestion(id, root.id, input, author), status(409));
    assert.deepEqual(snapshot(store), after);
  } finally { store.close(); }
});

test('a later-file source size failure rejects every proposed replacement and keeps all evidence unchanged', () => {
  const store = new Store({ path: ':memory:' });
  try {
    const detail = create(store, [sourceFiles[0]!, { path: 'appendix.tex', content: 'x'.repeat(500_000) }]), id = detail.revision.id, version = detail.versions[0]!;
    const root = store.createComment(id, { body: 'Apply all edits together.', versionId: version.id, filePath: 'main.tex', passage, suggestion: { replacement, additionalEdits: [{ anchor: createPassageAnchor(version, 'appendix.tex', { start: 0, end: 1, quote: 'x' }), replacement: 'xx', explanation: 'Expand the later file.' }] } }, reviewer);
    const before = snapshot(store);
    assert.throws(() => store.applySuggestion(id, root.id, expected(store.detail(id), root.id), author), status(400));
    assert.deepEqual(snapshot(store), before);
  } finally { store.close(); }
});
