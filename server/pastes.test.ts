import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { ActorAttribution } from '../shared/types.ts';
import { validatePasteContent, PASTE_MAX_BYTES } from '../shared/pastes.ts';
import { Store } from './store.ts';
import { PasteStore, parseCreatePasteInput, parseUpdatePasteInput, parsePasteCommentInput } from './pastes.ts';

const alice: ActorAttribution = { principalId: 'alice', displayName: 'Alice', credentialId: 'token-alice', requestId: 'paste-request' };
const bob: ActorAttribution = { principalId: 'bob', displayName: 'Bob', credentialId: null, requestId: 'bob-request' };
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const fixture = () => new Store({ path: ':memory:' });

test('Pastes preserve exact BOM, mixed newlines, whitespace and UTF-8 with immutable author attribution', () => {
  const store = fixture();
  try {
    const content = '\ufeff\r\n\tconst π = "🧪";\r\n\n\r  ';
    const record = store.pastes.create({ title: '  Exact sample  ', language: ' UnlistedDialect ', content }, alice);
    assert.equal(record.id, 'PA1'); assert.equal(record.title, 'Exact sample'); assert.equal(record.language, 'UnlistedDialect'); assert.equal(record.authorId, 'alice');
    assert.equal(record.bytes, Buffer.byteLength(content)); assert.equal(record.contentHash, sha(content)); assert.equal(record.lineCount, 5);
    assert.equal(store.pastes.version(record.id).content, content); assert.deepEqual(store.pastes.version(record.id).attribution, alice);
    assert.deepEqual(store.pastes.snapshot(record.id, 1), record); assert.deepEqual(store.pastes.get(record.id), record);
    assert.ok(store.database.prepare('SELECT data FROM object_policies WHERE object_id=?').get(record.id));
    assert.equal(store.pastes.create({ content: '\t \r\n' }, bob).title, '');
    const version = store.pastes.version(record.id); version.attribution.displayName = 'Forged';
    assert.equal(store.pastes.version(record.id).attribution.displayName, 'Alice');
  } finally { store.close(); }
});

test('metadata edits, exact content versions, archive, no-op and stale writes maintain separate counters', () => {
  const store = fixture();
  try {
    const first = store.pastes.create({ title: 'Initial', content: 'one\r\n', language: 'ts' }, alice);
    const metadata = store.pastes.update(first.id, { expectedVersion: 1, title: ' Updated ', language: null, status: 'archived' }, bob);
    assert.equal(metadata.version, 2); assert.equal(metadata.contentVersion, 1); assert.equal(metadata.authorId, 'alice'); assert.equal(metadata.contentHash, first.contentHash);
    const activityBefore = store.database.prepare('SELECT COUNT(*) AS n FROM activity').get();
    assert.deepEqual(store.pastes.update(first.id, { expectedVersion: 2, title: 'Updated', content: 'one\r\n' }, alice), metadata);
    assert.deepEqual(store.database.prepare('SELECT COUNT(*) AS n FROM activity').get(), activityBefore); assert.equal(store.pastes.history(first.id).transactions.length, 2);
    assert.throws(() => store.pastes.update(first.id, { expectedVersion: 1, title: 'Updated' }, alice), { status: 409, code: 'PASTE_CONFLICT' });
    const changed = store.pastes.update(first.id, { expectedVersion: 2, content: 'one\n' }, bob);
    assert.equal(changed.version, 3); assert.equal(changed.contentVersion, 2); assert.equal(changed.status, 'archived');
    assert.equal(store.pastes.version(first.id, 1).content, 'one\r\n'); assert.equal(store.pastes.version(first.id, 2).content, 'one\n');
    assert.deepEqual(store.pastes.snapshot(first.id, 1), first); assert.deepEqual(store.pastes.snapshot(first.id, 2), metadata);
    const history = store.pastes.history(first.id).transactions;
    assert.deepEqual(store.pastes.transition(first.id, 3), history[0]); assert.equal(store.pastes.transition(first.id, 99), null);
    assert.deepEqual(history[0].contentChange, { from: 1, to: 2, fromHash: first.contentHash, toHash: changed.contentHash });
    assert.deepEqual(history[1].changes, [{ field: 'title', oldValue: 'Initial', newValue: 'Updated' }, { field: 'language', oldValue: 'ts', newValue: null }, { field: 'status', oldValue: 'active', newValue: 'archived' }]);
    assert.equal(store.pastes.list({}, () => true).pastes.length, 0); assert.equal(store.pastes.list({ status: 'all' }, () => true).pastes.length, 1);
    assert.equal(store.pastes.update(first.id, { expectedVersion: 3, status: 'active' }, alice).contentVersion, 2);
  } finally { store.close(); }
});

test('comments bind historical immutable content, never advance paste counters, and page exact history', () => {
  const store = fixture();
  try {
    const original = store.pastes.create({ content: 'old' }, alice); const current = store.pastes.update(original.id, { expectedVersion: 1, content: 'new' }, alice);
    const comment = store.pastes.comment(original.id, { contentVersion: 1, body: '  Read this exact old text.  ' }, bob);
    assert.equal(comment.kind, 'comment'); assert.equal(comment.comment, 'Read this exact old text.'); assert.equal(comment.contentVersion, 1); assert.equal(comment.contentHash, original.contentHash); assert.equal(comment.pasteVersion, 2);
    assert.deepEqual(comment.attribution, bob); assert.deepEqual(store.pastes.get(original.id), current); assert.deepEqual(store.pastes.transaction(original.id, comment.id), comment);
    assert.throws(() => store.pastes.comment(original.id, { contentVersion: 9, body: 'wrong' }, bob), { status: 404, code: 'PASTE_VERSION_UNAVAILABLE' });
    const page1 = store.pastes.history(original.id, undefined, 2); assert.deepEqual(page1.transactions.map(item => item.sequence), [3, 2]); assert.equal(page1.nextBefore, 2);
    assert.deepEqual(store.pastes.history(original.id, 2, 2).transactions.map(item => item.sequence), [1]);
    const versions = store.pastes.versions(original.id, undefined, 1); assert.equal(versions.versions[0].number, 2); assert.equal(versions.nextBefore, 2); assert.equal('content' in versions.versions[0], false);
    assert.equal(store.pastes.versions(original.id, 2, 1).versions[0].sha256, original.contentHash);
    assert.throws(() => store.pastes.transaction(original.id, 'missing'), { status: 404, code: 'PASTE_TRANSACTION_UNAVAILABLE' });
  } finally { store.close(); }
});

test('validates byte limits, malformed Unicode, title/language normalization and mutation field boundaries', () => {
  assert.equal(validatePasteContent('x'.repeat(PASTE_MAX_BYTES)).bytes, PASTE_MAX_BYTES);
  for (const value of ['', '\0', '\ud800', '\udfff', 'π'.repeat(PASTE_MAX_BYTES / 2 + 1), 1, null]) assert.throws(() => parseCreatePasteInput({ content: value }), { status: 400 });
  assert.equal(validatePasteContent('🧪').bytes, 4);
  assert.deepEqual(parseCreatePasteInput({ content: ' ', title: '  ', language: null }), { content: ' ', title: '', language: null });
  for (const request of [{ content: 'x', title: 'x'.repeat(256) }, { content: 'x', language: '' }, { content: 'x', language: 'x'.repeat(65) }, { content: 'x', language: '\ud800' }, { content: 'x', arbitrary: true }]) assert.throws(() => parseCreatePasteInput(request), { status: 400 });
  for (const request of [{ expectedVersion: 0 }, { expectedVersion: 1, status: 'deleted' }, { expectedVersion: 1, content: '' }, { expectedVersion: 1, authorId: 'bob' }]) assert.throws(() => parseUpdatePasteInput(request), { status: 400 });
  for (const request of [{ contentVersion: 0, body: 'x' }, { contentVersion: 1, body: ' ' }, { contentVersion: 1, body: 'x'.repeat(10_001) }, { contentVersion: 1, body: '\ud800' }]) assert.throws(() => parsePasteCommentInput(request), { status: 400 });
});

test('listing filters current content literally, bounds snippets, filters visibility before paging and validates dates', () => {
  const store = fixture();
  try {
    const one = store.pastes.create({ title: 'Percent % literal', language: 'ts', content: 'hidden-old' }, alice);
    store.pastes.update(one.id, { expectedVersion: 1, content: 'visible-new' }, alice);
    const two = store.pastes.create({ title: 'Second', content: `${'a'.repeat(239)}🧪${'long'.repeat(100)}` }, bob);
    const three = store.pastes.create({ title: 'Private match', content: 'visible-new' }, bob);
    assert.deepEqual(store.pastes.list({ query: '%' }, () => true).pastes.map(item => item.id), [one.id]);
    assert.equal(store.pastes.list({ query: 'hidden-old' }, () => true).pastes.length, 0);
    assert.deepEqual(store.pastes.list({ query: 'VISIBLE-NEW' }, value => value !== three.id).pastes.map(item => item.id), [one.id]);
    assert.deepEqual(store.pastes.list({ authorId: 'alice', language: 'ts' }, () => true).pastes.map(item => item.id), [one.id]);
    assert.deepEqual(store.pastes.list({ language: null }, () => true).pastes.map(item => item.id), [three.id, two.id]);
    const first = store.pastes.list({ limit: 1 }, value => value !== three.id); assert.equal(first.pastes[0].id, two.id); assert.equal(first.pastes[0].snippet.length, 239); assert.ok(first.nextBefore);
    assert.deepEqual(store.pastes.list({ limit: 1, before: first.nextBefore! }, () => true).pastes.map(item => item.id), [one.id]);
    assert.equal(store.pastes.list({ createdAfter: '2000-01-01T00:00:00Z', createdBefore: '2099-01-01T00:00:00.000Z' }, () => true).pastes.length, 3);
    for (const query of [{ createdAfter: '2025-02-30T00:00:00Z' }, { createdAfter: '2020-01-01' }, { createdAfter: '2020-01-02T00:00:00Z', createdBefore: '2020-01-01T00:00:00Z' }, { limit: 101 }, { before: 0 }]) assert.throws(() => store.pastes.list(query, () => true), { status: 400 });
    assert.deepEqual(store.pastes.list().pastes, [], 'visibility is closed by default');
  } finally { store.close(); }
});

test('a hidden prefix has a bounded scan and a continuation without exposing hidden snippets', () => {
  const store = fixture();
  try {
    store.transaction(() => { for (let index = 0; index < 1003; index++) store.pastes.create({ content: `private ${index}` }, alice); });
    let calls = 0; const page = store.pastes.list({ limit: 1 }, () => { calls++; return false; });
    assert.equal(calls, 1000); assert.deepEqual(page.pastes, []); assert.ok(page.nextBefore);
    const rest = store.pastes.list({ before: page.nextBefore!, limit: 5 }, () => true); assert.deepEqual(rest.pastes.map(item => item.id), ['PA3', 'PA2', 'PA1']); assert.equal(rest.nextBefore, null);
  } finally { store.close(); }
});

test('literal searches bound actual source bytes and resume the unscanned candidate without reading hidden content', () => {
  const store = fixture();
  try {
    const match = store.pastes.create({ content: 'ÄPFEL find me' }, alice);
    store.transaction(() => { for (let index = 0; index < 17; index++) store.pastes.create({ content: 'x'.repeat(PASTE_MAX_BYTES) }, alice); });
    const hidden = store.pastes.create({ content: 'secret' }, bob);
    // Even corrupted hidden source must never be touched by a listing.
    store.database.exec('DROP TRIGGER paste_versions_no_update'); store.database.prepare("UPDATE paste_versions SET data=json_set(data,'$.content','corrupt') WHERE paste_id=?").run(hidden.id);
    const read = store.pastes.version.bind(store.pastes); let bytes = 0;
    store.pastes.version = (pasteId, number) => { assert.notEqual(pasteId, hidden.id); const result = read(pasteId, number); bytes += result.bytes; return result; };
    const first = store.pastes.list({ query: 'äpfel' }, value => value !== hidden.id);
    assert.deepEqual(first.pastes, []); assert.equal(bytes, 16 * PASTE_MAX_BYTES); assert.ok(first.nextBefore);
    bytes = 0; const second = store.pastes.list({ query: 'äpfel', before: first.nextBefore! }, value => value !== hidden.id);
    assert.deepEqual(second.pastes.map(item => item.id), [match.id]); assert.equal(bytes, PASTE_MAX_BYTES + match.bytes); assert.equal(second.nextBefore, null);
  } finally { store.close(); }
});

test('append-only storage, integrity checking and transaction rollback prevent partial histories and ID consumption', () => {
  const store = fixture();
  try {
    const first = store.pastes.create({ content: 'original' }, alice); const db = store.database;
    for (const sql of ["UPDATE paste_versions SET data='{}'", 'DELETE FROM paste_versions', "UPDATE paste_transactions SET data='{}'", 'DELETE FROM paste_transactions', "UPDATE entities SET data=json_set(data,'$.authorId','bob') WHERE kind='paste'"]) assert.throws(() => db.exec(sql), /immutable/);
    const failing = new PasteStore(db, { nextId: () => { const row = db.prepare("UPDATE sequences SET value=value+1 WHERE name='paste' RETURNING value").get() as { value: number }; return `PA${row.value}`; }, event: () => { throw new Error('event write failed'); } });
    assert.throws(() => failing.create({ content: 'failed' }, bob), /event write failed/);
    assert.equal(store.pastes.create({ content: 'next' }, bob).id, 'PA2');
    assert.throws(() => failing.update(first.id, { expectedVersion: 1, content: 'failed edit' }, bob), /event write failed/); assert.deepEqual(store.pastes.get(first.id), first); assert.equal(store.pastes.versions(first.id).versions.length, 1);
    assert.throws(() => failing.comment(first.id, { contentVersion: 1, body: 'failed comment' }, bob), /event write failed/); assert.equal(store.pastes.history(first.id).transactions.length, 1);
    db.exec('DROP TRIGGER paste_versions_no_update'); db.prepare("UPDATE paste_versions SET data=json_set(data,'$.content','corrupt') WHERE paste_id=?").run(first.id);
    assert.throws(() => store.pastes.version(first.id), { status: 409, code: 'PASTE_INTEGRITY' });
  } finally { store.close(); }
});
