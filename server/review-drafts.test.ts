import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from './store.ts';
import { inspectDocx } from './docx-package.ts';
import { registerFilePolicy } from './policy.ts';
import { reviewDraftInputHash, reviewDraftMentionRequestHash, reviewDraftPayloadHash } from './review-drafts.ts';
import { REVIEW_DRAFT_LIMITS, isReviewDraftPreview, reviewDraftSaveInput, validReviewDraftResult, type ReviewDraftPayload } from '../shared/review-drafts.ts';
import type { ActorAttribution } from '../shared/types.ts';

const alice: ActorAttribution = { principalId: 'alice', displayName: 'Alice Reviewer', credentialId: 'alice-token', requestId: 'alice-request' };
const bob: ActorAttribution = { principalId: 'bob', displayName: 'Bob Reviewer', credentialId: 'bob-token', requestId: 'bob-request' };
const digest = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex');
const key = () => digest(randomUUID());
const epoch = (s: Store) => Number(s.database.prepare("SELECT value FROM policy_meta WHERE name='epoch'").get()!.value);
const status = (code: number) => (e: unknown) => Boolean(e && typeof e === 'object' && 'status' in e && e.status === code);
function fixture(s: Store) { const d = s.createRevision({ title: 'Private academic discussion', testPlan: 'Read each exact quotation.', kind: 'paper', files: [{ path: 'paper.tex', content: 'Original result.\nSecond paragraph.\n' }] }, alice); return { id: d.revision.id, version: d.versions[0]! }; }
function payload(f: ReturnType<typeof fixture>, body = 'Private reasoning'): ReviewDraftPayload { return { kind: 'comment', body, versionId: f.version.id, contentHash: f.version.contentHash, filePath: 'paper.tex', line: 1, passage: { start: 0, end: 8, quote: 'Original' }, suggestion: { replacement: 'Revised' } }; }
function save(s: Store, f: ReturnType<typeof fixture>, body = 'Private reasoning', actor = alice) { const id = randomUUID(), input = { expectedEntryVersion: 0, expectedAccessEpoch: epoch(s), payload: payload(f, body) }, retry = key(); return { receipt: s.reviewDrafts.save(f.id, id, input, actor, retry), input, retry, id }; }
function data(s: Store, table: string) { return s.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(); }
function publicEvidence(s: Store) { return ['comments', 'review_threads', 'thread_events', 'activity', 'notification_events', 'notification_deliveries', 'revision_subscription_transactions', 'revision_subscriptions'].filter(t => s.database.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(t)).map(t => [t, data(s, t)]); }
function allEvidence(s: Store) { return [...publicEvidence(s), ...['review_draft_sets', 'review_draft_entries', 'review_draft_operations', 'idempotency'].map(t => [t, data(s, t)])]; }
function publish(s: Store, id: string, actor = alice) { const input = { manifest: s.reviewDrafts.preview(id, actor.principalId).manifest }, retry = key(); return { input, retry, receipt: s.reviewDrafts.publish(id, input, actor, retry) }; }

test('private owner sets and discovery preserve shared discussion and have no mention or notification side effects', () => {
  const s = new Store({ path: ':memory:' }); try {
    s.notifications.configure({ eligible: () => true, canView: () => true }); let mentions = 0; s.configureMentions({ resolve: () => { mentions++; return { principalId: bob.principalId, displayName: bob.displayName }; } });
    const f = fixture(s), before = publicEvidence(s), detail = s.detail(f.id); const a = save(s, f, 'Privately consider @bob');
    assert.deepEqual(publicEvidence(s), before); assert.deepEqual(s.detail(f.id), detail); assert.equal(mentions, 0);
    assert.equal(s.reviewDrafts.snapshot(f.id, alice.principalId).entries[0]!.id, a.id); assert.deepEqual(s.reviewDrafts.snapshot(f.id, bob.principalId).entries, []);
    assert.deepEqual(s.reviewDrafts.discover(bob.principalId, () => true).items, []);
    assert.deepEqual(s.reviewDrafts.discover(alice.principalId, () => false).items, []);
    assert.equal(s.reviewDrafts.discover(alice.principalId, () => true).items[0]!.entryCount, 1);
    assert.throws(() => s.reviewDrafts.save(f.id, a.id, { ...a.input, expectedEntryVersion: 1 }, bob, key()), status(404));
    assert.throws(() => s.reviewDrafts.discard(f.id, a.id, { expectedEntryVersion: 1, expectedAccessEpoch: epoch(s) }, bob, key()), status(404));
    const hidden = fixture(s), other = fixture(s); save(s, hidden); save(s, other);
    const first = s.reviewDrafts.discover(alice.principalId, id => id !== hidden.id, { limit: 1 }); assert.equal(first.items.length, 1); assert.ok(first.nextAfter);
    const second = s.reviewDrafts.discover(alice.principalId, id => id !== hidden.id, { after: first.nextAfter!, limit: 1 }); assert.equal(second.items.length, 1); assert.equal(second.nextAfter, null); assert.notEqual(first.items[0]!.revisionId, second.items[0]!.revisionId);
  } finally { s.close(); }
});

test('entry CAS is independent, exact text is preserved, stale writes and terminal identity resurrection fail', () => {
  const s = new Store({ path: ':memory:' }); try {
    const f = fixture(s), a = save(s, f, '  whitespace\n'), b = save(s, f, 'Another entry');
    const changed = { ...a.input, expectedEntryVersion: 1, payload: payload(f, 'More detail') }; const r = s.reviewDrafts.save(f.id, a.id, changed, alice, key());
    assert.equal(r.entry.version, 2); assert.equal(r.setVersion, 3); assert.equal(s.reviewDrafts.snapshot(f.id, alice.principalId).entries.find(e => e.id === b.id)!.version, 1);
    assert.equal(s.reviewDrafts.operation(a.receipt.operationId).receipt.kind, 'save'); assert.equal(a.receipt.entry.payload.body, '  whitespace\n');
    assert.throws(() => s.reviewDrafts.save(f.id, a.id, changed, alice, key()), status(409));
    assert.throws(() => s.reviewDrafts.discard(f.id, a.id, { expectedEntryVersion: 1, expectedAccessEpoch: epoch(s) }, alice, key()), status(409));
    const discard = s.reviewDrafts.discard(f.id, a.id, { expectedEntryVersion: 2, expectedAccessEpoch: epoch(s) }, alice, key()); assert.equal(discard.entry.version, 3); assert.equal(discard.entry.state, 'discarded');
    assert.throws(() => s.reviewDrafts.save(f.id, a.id, { ...a.input, expectedEntryVersion: 3 }, alice, key()), status(409));
    assert.equal(s.reviewDrafts.snapshot(f.id, alice.principalId).entries.length, 1);
    const p = publish(s, f.id); assert.equal(p.receipt.published[0]!.draftId, b.id); assert.throws(() => s.reviewDrafts.save(f.id, b.id, { ...b.input, expectedEntryVersion: 2 }, alice, key()), status(409));
  } finally { s.close(); }
});

test('strict payloads reject unknown fields, foreign or forged sources, malformed anchors and invalid Unicode without writes', () => {
  const s = new Store({ path: ':memory:' }); try {
    const f = fixture(s), other = fixture(s), before = allEvidence(s), good = { expectedEntryVersion: 0, expectedAccessEpoch: epoch(s), payload: payload(f) };
    for (const value of [{ ...good, principalId: 'bob' }, { ...good, expectedEntryVersion: 0.5 }, { ...good, payload: { ...good.payload, body: '  ' } }, { ...good, payload: { ...good.payload, body: '\ud800' } }, { ...good, payload: { ...good.payload, hidden: true } }, { ...good, payload: { ...good.payload, passage: { start: 0, end: 8, quote: 'Mismatched' } } }, { ...good, payload: { ...good.payload, line: 999 } }, { ...good, payload: { ...good.payload, versionId: other.version.id, contentHash: other.version.contentHash } }]) assert.throws(() => s.reviewDrafts.save(f.id, randomUUID(), value, alice, key()), status(400));
    assert.throws(() => s.reviewDrafts.save(f.id, randomUUID(), { ...good, payload: { ...good.payload, contentHash: 'a'.repeat(64) } }, alice, key()), status(409));
    assert.throws(() => s.reviewDrafts.save(f.id, randomUUID(), { ...good, expectedAccessEpoch: 0 }, alice, key()), status(409));
    assert.deepEqual(allEvidence(s), before);
    assert.equal(JSON.stringify(reviewDraftSaveInput(good)), JSON.stringify(reviewDraftSaveInput({ payload: good.payload, expectedAccessEpoch: good.expectedAccessEpoch, expectedEntryVersion: 0 })));
  } finally { s.close(); }
});

test('preview pins complete draft set, immutable sources, current head and each distinct reply thread', () => {
  const s = new Store({ path: ':memory:' }); try {
    const f = fixture(s), root = s.createComment(f.id, { body: 'Published root', versionId: f.version.id }); const staged = save(s, f);
    for (const body of ['Reply A', 'Reply B']) s.reviewDrafts.save(f.id, randomUUID(), { expectedEntryVersion: 0, expectedAccessEpoch: epoch(s), payload: { kind: 'reply', body, threadId: root.threadId!, viewedVersionId: f.version.id, viewedContentHash: f.version.contentHash } }, alice, key());
    const preview = s.reviewDrafts.preview(f.id, alice.principalId); assert.ok(isReviewDraftPreview(preview, f.id, alice.principalId)); assert.equal(preview.manifest.threads.length, 1); assert.equal(preview.manifest.entries.length, 3); assert.equal(preview.manifest.sources.length, 1);
    const withoutOne = { manifest: { ...preview.manifest, entries: preview.manifest.entries.slice(1) } }; assert.throws(() => s.reviewDrafts.publish(f.id, withoutOne, alice, key()), status(409));
    s.reviewDrafts.save(f.id, staged.id, { ...staged.input, expectedEntryVersion: 1, payload: payload(f, 'Later edit') }, alice, key());
    assert.throws(() => s.reviewDrafts.publish(f.id, { manifest: preview.manifest }, alice, key()), status(409));
    const current = s.reviewDrafts.preview(f.id, alice.principalId); const result = s.reviewDrafts.publish(f.id, { manifest: current.manifest }, alice, key());
    assert.equal(result.published.length, 3); assert.equal(s.detail(f.id).threads.find(t => t.id === root.threadId)!.version, 3); assert.deepEqual(s.reviewDrafts.snapshot(f.id, alice.principalId).entries, []);
    for (const item of result.published) if (item.comment.threadId === root.threadId) { assert.equal(item.comment.versionId, root.versionId); assert.equal(item.comment.viewedVersionId, f.version.id); }
  } finally { s.close(); }
});

test('head, thread and access changes require re-preview while historical anchors remain exact', () => {
  const s = new Store({ path: ':memory:' }); try {
    const f = fixture(s); save(s, f); const old = s.reviewDrafts.preview(f.id, alice.principalId);
    s.createVersion(f.id, { expectedVersion: 1, message: 'New content', files: [{ path: 'paper.tex', content: 'New wording' }] }, alice);
    assert.throws(() => s.reviewDrafts.publish(f.id, { manifest: old.manifest }, alice, key()), status(409));
    const newer = s.reviewDrafts.preview(f.id, alice.principalId); assert.equal(newer.head.number, 2); assert.equal(newer.entries[0]!.payload.kind !== 'reply' && newer.entries[0]!.payload.versionId, f.version.id);
    s.database.exec("UPDATE policy_meta SET value=value+1 WHERE name='epoch'"); assert.throws(() => s.reviewDrafts.publish(f.id, { manifest: newer.manifest }, alice, key()), status(409));
    const published = publish(s, f.id).receipt.published[0]!.comment; assert.equal(published.versionId, f.version.id); assert.equal(published.anchor!.quote, 'Original');
    const reply = { kind: 'reply' as const, body: 'Pending reply', threadId: published.threadId!, viewedVersionId: f.version.id, viewedContentHash: f.version.contentHash };
    s.reviewDrafts.save(f.id, randomUUID(), { expectedEntryVersion: 0, expectedAccessEpoch: epoch(s), payload: reply }, alice, key()); const beforeReply = s.reviewDrafts.preview(f.id, alice.principalId);
    s.createReply(f.id, published.threadId!, { body: 'Someone else replied', viewedVersionId: f.version.id }, bob); assert.throws(() => s.reviewDrafts.publish(f.id, { manifest: beforeReply.manifest }, alice, key()), status(409));
  } finally { s.close(); }
});

test('direct publication rolls back every shared/private effect when the final comment or operation evidence fails', () => {
  const s = new Store({ path: ':memory:' }); try {
    s.notifications.configure({ eligible: () => true, canView: () => true }); const f = fixture(s);
    const ids = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'];
    ids.forEach((id, i) => s.reviewDrafts.save(f.id, id, { expectedEntryVersion: 0, expectedAccessEpoch: epoch(s), payload: payload(f, i === 0 ? 'First comment' : 'Last comment') }, bob, key()));
    const input = { manifest: s.reviewDrafts.preview(f.id, bob.principalId).manifest }, before = allEvidence(s);
    s.database.exec("CREATE TRIGGER fail_last_comment BEFORE INSERT ON comments WHEN json_extract(NEW.data,'$.body')='Last comment' BEGIN SELECT RAISE(ABORT,'injected last comment failure'); END");
    assert.throws(() => s.reviewDrafts.publish(f.id, input, bob, key()), /injected last comment failure/); assert.deepEqual(allEvidence(s), before);
    s.database.exec('DROP TRIGGER fail_last_comment');
    s.database.exec("CREATE TRIGGER fail_publication BEFORE INSERT ON review_draft_operations WHEN json_extract(NEW.data,'$.kind')='publish' BEGIN SELECT RAISE(ABORT,'injected receipt failure'); END");
    assert.throws(() => s.reviewDrafts.publish(f.id, input, bob, key()), /injected receipt failure/); assert.deepEqual(allEvidence(s), before); s.database.exec('DROP TRIGGER fail_publication');
    assert.equal(s.reviewDrafts.publish(f.id, input, bob, key()).published.length, 2);
  } finally { s.close(); }
});

test('publication composes with Store.mutate and each normal mention/subscription/notification side effect occurs once', () => {
  const s = new Store({ path: ':memory:' }); try {
    s.notifications.configure({ eligible: () => true, canView: () => true }); let resolution = 0; s.configureMentions({ resolve: () => { resolution++; return { principalId: 'alice', displayName: 'Alice Reviewer' }; } });
    const f = fixture(s); save(s, f, '@alice Please clarify', bob); save(s, f, '@alice Another observation', bob); assert.equal(resolution, 0);
    const input = { manifest: s.reviewDrafts.preview(f.id, bob.principalId).manifest }, retry = key();
    const response = s.mutate('batch', 'exact', () => ({ status: 201, body: s.reviewDrafts.publish(f.id, input, bob, retry) })); assert.equal(resolution, 2);
    const after = allEvidence(s); assert.deepEqual(s.mutate('batch', 'exact', () => { throw new Error('must not execute'); }), response); assert.deepEqual(allEvidence(s), after);
    const direct = s.reviewDrafts.publish(f.id, input, bob, retry); assert.deepEqual(direct, response.body); assert.equal(resolution, 2); assert.deepEqual(allEvidence(s), after);
    assert.equal(s.detail(f.id).comments.length, 2); assert.equal(s.notifications.list(alice.principalId, {}, epoch(s)).items.filter(i => i.event.kind === 'commented').length, 2);
    const operation = s.reviewDrafts.operation(direct.operationId); for (const item of direct.published) assert.equal(item.comment.mentions?.requestSha256, reviewDraftMentionRequestHash(operation.retryKeySha256, operation.inputSha256));
    assert.ok(validReviewDraftResult(direct, f.id, 'publish', input, null, bob.principalId));
  } finally { s.close(); }
});

test('exact save/discard/publication retry survives restart and later source/access changes; changed requests conflict', () => {
  const directory = mkdtempSync(join(tmpdir(), 'private-review-')), path = join(directory, 'workspace.sqlite'); let s = new Store({ path });
  try {
    const f = fixture(s), a = save(s, f); const discardInput = { expectedEntryVersion: 1, expectedAccessEpoch: epoch(s) }, discardKey = key(); const discarded = s.reviewDrafts.discard(f.id, a.id, discardInput, alice, discardKey);
    save(s, f, 'Publish retained work'); const publication = publish(s, f.id); const before = allEvidence(s); s.close(); s = new Store({ path });
    assert.deepEqual(s.reviewDrafts.save(f.id, a.id, a.input, alice, a.retry), a.receipt); assert.deepEqual(s.reviewDrafts.discard(f.id, a.id, discardInput, alice, discardKey), discarded); assert.deepEqual(s.reviewDrafts.publish(f.id, publication.input, alice, publication.retry), publication.receipt); assert.deepEqual(allEvidence(s), before);
    s.createVersion(f.id, { expectedVersion: 1, message: 'Later', files: [{ path: 'paper.tex', content: 'Later source' }] }, alice); s.database.exec("UPDATE policy_meta SET value=value+1 WHERE name='epoch'");
    assert.deepEqual(s.reviewDrafts.publish(f.id, publication.input, alice, publication.retry), publication.receipt);
    assert.throws(() => s.reviewDrafts.save(f.id, a.id, { ...a.input, payload: payload(f, 'Different') }, alice, a.retry), status(409));
    assert.throws(() => s.reviewDrafts.publish(f.id, { manifest: { ...publication.input.manifest, expectedSetVersion: 9 } }, alice, publication.retry), status(409));
  } finally { s.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('summary and entry limits fail explicitly without truncating a complete review', () => {
  const s = new Store({ path: ':memory:' }); try {
    const f = fixture(s), summary: ReviewDraftPayload = { kind: 'summary', body: 'Review summary', versionId: f.version.id, contentHash: f.version.contentHash };
    const input = { expectedEntryVersion: 0, expectedAccessEpoch: epoch(s), payload: summary }; s.reviewDrafts.save(f.id, randomUUID(), input, alice, key());
    assert.throws(() => s.reviewDrafts.save(f.id, randomUUID(), input, alice, key()), status(422));
    for (let i = 1; i < REVIEW_DRAFT_LIMITS.entries; i++) save(s, f, `Entry ${i}`); const before = allEvidence(s);
    assert.throws(() => save(s, f, 'Overflow'), status(422)); assert.deepEqual(allEvidence(s), before); assert.equal(s.reviewDrafts.preview(f.id, alice.principalId).entries.length, REVIEW_DRAFT_LIMITS.entries);
  } finally { s.close(); }
});

test('Word private passages use the immutable package validator and publish as native Word comments', async () => {
  const s = new Store({ path: ':memory:' }); try {
    const bytes = readFileSync(new URL('../tests/fixtures/docx/roundtrip.docx', import.meta.url)), projection = await inspectDocx(bytes);
    const file = s.files.upload({ name: 'Paper.docx', bytes: bytes.length, sha256: digest(bytes), dataBase64: bytes.toString('base64') }, alice); registerFilePolicy(s.database, file.id, alice.principalId);
    const detail = s.createDocxRevision({ title: 'Word private drafts', testPlan: 'Inspect exact package.', sourceFile: { fileId: file.id, sha256: file.sha256, bytes: file.bytes }, shareSource: true, expectedAccessEpoch: epoch(s) }, bytes, projection, alice), version = detail.versions[0]!, range = version.docx!.projection.editableRanges.find(r => r.text === 'The original result is clear.')!;
    const p: ReviewDraftPayload = { kind: 'comment', body: 'Clarify the result', versionId: version.id, contentHash: version.contentHash, filePath: null, line: null, docxPassage: { rangeId: range.id, start: 4, end: 19, quote: range.text.slice(4, 19) } };
    s.reviewDrafts.save(detail.revision.id, randomUUID(), { expectedEntryVersion: 0, expectedAccessEpoch: epoch(s), payload: p }, alice, key()); assert.equal(s.detail(detail.revision.id).comments.length, 0);
    const receipt = publish(s, detail.revision.id).receipt; assert.equal(receipt.published[0]!.comment.docxAnchor!.quote, p.docxPassage!.quote); assert.equal(receipt.published[0]!.comment.filePath, null);
    const operation = s.reviewDrafts.operation(receipt.operationId); assert.equal(operation.inputSha256, reviewDraftInputHash('publish', null, operation.input));
  } finally { s.close(); }
});

test('receipt evidence is immutable and forged stored comment data cannot validate as a publication', () => {
  const s = new Store({ path: ':memory:' }); try {
    const f = fixture(s), draft = save(s, f); assert.equal(draft.receipt.entry.payloadSha256, reviewDraftPayloadHash(draft.input.payload)); const p = publish(s, f.id);
    assert.throws(() => s.database.prepare('DELETE FROM review_draft_operations WHERE id=?').run(p.receipt.operationId), /immutable/);
    assert.throws(() => s.database.prepare('UPDATE review_draft_entries SET state=? WHERE id=?').run('active', draft.id), /cannot change/);
    const comment = p.receipt.published[0]!.comment; s.database.exec('DROP TRIGGER comments_no_update'); s.database.prepare('UPDATE comments SET data=? WHERE id=?').run(JSON.stringify({ ...comment, body: 'Changed bytes' }), comment.id);
    assert.throws(() => s.reviewDrafts.operation(p.receipt.operationId), status(409)); assert.throws(() => s.reviewDrafts.publish(f.id, p.input, alice, p.retry), status(409));
  } finally { s.close(); }
});

test('schema35 adds private storage without changing historical rows and refuses schema collisions atomically', () => {
  const directory = mkdtempSync(join(tmpdir(), 'review-draft-migration-')), path = join(directory, 'db.sqlite'); let s = new Store({ path });
  const snapshot = (db: DatabaseSync) => {
    const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all() as { type: string; name: string }[];
    return { schema, rows: Object.fromEntries(schema.filter(row => row.type === 'table').map(row => [row.name, db.prepare(`SELECT * FROM "${row.name}" ORDER BY rowid`).all()])) };
  };
  try {
    const f = fixture(s); s.createComment(f.id, { body: 'Historical @literal comment\r\n😀', versionId: f.version.id }, alice);
    // Remove exactly the three introduced tables (including their indexes and
    // triggers) to construct the prior schema, not merely relabel a new schema.
    s.database.exec("DROP TABLE review_draft_operations; DROP TABLE review_draft_entries; DROP TABLE review_draft_sets; CREATE TABLE operator_notes(note TEXT); INSERT INTO operator_notes VALUES('Preserve'); PRAGMA user_version=34");
    const before = snapshot(s.database); s.close(); s = new Store({ path });
    assert.equal(s.database.prepare('PRAGMA user_version').get()!.user_version, 42);
    const after = snapshot(s.database); for (const row of before.schema) assert.deepEqual(after.schema.find(next => next.name === row.name), row); for (const [table, rows] of Object.entries(before.rows)) assert.deepEqual(after.rows[table], rows);
    assert.deepEqual(s.reviewDrafts.snapshot(f.id, alice.principalId).entries, []); assert.deepEqual(s.database.prepare('PRAGMA foreign_key_check').all(), []);
    s.database.exec("DROP TABLE review_draft_operations; DROP TABLE review_draft_entries; DROP TABLE review_draft_sets; CREATE TABLE review_draft_sets(operator_note TEXT); INSERT INTO review_draft_sets VALUES('Do not overwrite'); PRAGMA user_version=34");
    const collision = snapshot(s.database); s.close(); assert.throws(() => new Store({ path }), /review_draft_sets schema/);
    const db = new DatabaseSync(path); try { assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 34); assert.deepEqual(snapshot(db), collision); } finally { db.close(); }
  } finally { if (s.database.isOpen) s.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('aggregate text bounds and a notification delivery failure preserve all staged work', () => {
  const s = new Store({ path: ':memory:' }); try {
    s.notifications.configure({ eligible: () => true, canView: () => true }); const f = fixture(s);
    for (let i = 0; i < 12; i++) save(s, f, 'x'.repeat(REVIEW_DRAFT_LIMITS.body), bob);
    const before = allEvidence(s); assert.throws(() => save(s, f, 'x'.repeat(REVIEW_DRAFT_LIMITS.body), bob), status(422)); assert.deepEqual(allEvidence(s), before);
    const preview = s.reviewDrafts.preview(f.id, bob.principalId);
    s.database.exec("CREATE TRIGGER fail_review_delivery BEFORE INSERT ON notification_deliveries BEGIN SELECT RAISE(ABORT,'injected delivery failure'); END");
    assert.throws(() => s.reviewDrafts.publish(f.id, { manifest: preview.manifest }, bob, key()), /injected delivery failure/); assert.deepEqual(allEvidence(s), before);
    s.database.exec('DROP TRIGGER fail_review_delivery'); assert.equal(s.reviewDrafts.publish(f.id, { manifest: preview.manifest }, bob, key()).published.length, 12);
    assert.equal(s.notifications.list(alice.principalId, {}, epoch(s)).items.length, 12);
  } finally { s.close(); }
});

test('private multi-passage edits preserve complete exact payloads through preview, publication and retry', () => {
  const s = new Store({ path: ':memory:' });
  try {
    const f = fixture(s), original = payload(f), anchor = { versionId: f.version.id, contentHash: f.version.contentHash, filePath: 'paper.tex', start: 17, end: 33, quote: 'Second paragraph', prefix: 'Original result.\n', suffix: '.\n' };
    const draft = { ...original, suggestion: { replacement: 'Revised', additionalEdits: [{ anchor, replacement: 'Companion result', explanation: 'Keep the discussion consistent.\r\n' }] } };
    const input = { expectedEntryVersion: 0, expectedAccessEpoch: epoch(s), payload: draft }, id = randomUUID(), retry = key(), before = publicEvidence(s);
    const saved = s.reviewDrafts.save(f.id, id, input, alice, retry);
    assert.deepEqual(publicEvidence(s), before);
    assert.deepEqual(saved.entry.payload, draft);
    assert.deepEqual(s.reviewDrafts.save(f.id, id, input, alice, retry), saved);
    const preview = s.reviewDrafts.preview(f.id, alice.principalId);
    assert.deepEqual(preview.entries[0]!.payload, draft); assert.equal(preview.manifest.sources.length, 1);
    const publishInput = { manifest: preview.manifest }, publishRetry = key();
    const receipt = s.reviewDrafts.publish(f.id, publishInput, alice, publishRetry);
    assert.equal(receipt.published.length, 1); assert.deepEqual(receipt.published[0]!.comment.suggestion, draft.suggestion);
    assert.deepEqual(s.reviewDrafts.publish(f.id, publishInput, alice, publishRetry), receipt);
    assert.deepEqual(s.reviewDrafts.operation(receipt.operationId).receipt, receipt);
    assert.equal(s.detail(f.id).versions.length, 1, 'publishing the proposal never applies it');
  } finally { s.close(); }
});

test('private multi-passage edits reject omitted explanations, overlap, foreign identity and forged context atomically', () => {
  const s = new Store({ path: ':memory:' });
  try {
    const f = fixture(s), foreign = fixture(s), original = payload(f), before = allEvidence(s);
    const anchor = { versionId: f.version.id, contentHash: f.version.contentHash, filePath: 'paper.tex', start: 17, end: 33, quote: 'Second paragraph', prefix: 'Original result.\n', suffix: '.\n' };
    const extra = { anchor, replacement: 'Companion result', explanation: 'Keep the discussion consistent.' };
    for (const edit of [{ ...extra, explanation: '' }, { ...extra, anchor: { ...anchor, versionId: foreign.version.id } }, { ...extra, anchor: { ...anchor, prefix: 'Forged context' } }, { ...extra, anchor: { ...anchor, start: 0, end: 8, quote: 'Original', prefix: '', suffix: ' result.\nSecond paragraph.\n' } }]) {
      assert.throws(() => s.reviewDrafts.save(f.id, randomUUID(), { expectedEntryVersion: 0, expectedAccessEpoch: epoch(s), payload: { ...original, suggestion: { replacement: 'Revised', additionalEdits: [edit] } } }, alice, key()), status(400));
      assert.deepEqual(allEvidence(s), before);
    }
  } finally { s.close(); }
});
