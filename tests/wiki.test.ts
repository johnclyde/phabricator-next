import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { AppState, WikiDetail, WikiDocument, WikiHistory, WikiVersion } from '../shared/types.ts';
import { createApp, type AppOptions } from '../server/app.ts';
import { createStore } from '../server/store.ts';

async function start(options: AppOptions = {}) {
  const app = createApp({ databasePath: ':memory:', seed: false, basePath: '/workspace/', ...options });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/workspace`;
  const request = async <T = { error: string }>(path: string, method = 'GET', data?: unknown, key?: string) => {
    const response = await fetch(`${base}${path}`, {
      method, headers: { ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key === undefined ? {} : { 'Idempotency-Key': key }) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    return { status: response.status, body: await response.json() as T };
  };
  return { ...app, request };
}

function createLegacyDatabase(path: string, document: WikiDocument): void {
  const database = new DatabaseSync(path);
  try {
    // Schema 1 is intentionally built directly, rather than using the current
    // store and pretending that a newly created database is a legacy one.
    database.exec(`
      CREATE TABLE entities (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('project','repository','revision','task','document')), data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE INDEX entities_kind ON entities(kind);
      CREATE UNIQUE INDEX documents_slug ON entities(json_extract(data, '$.slug')) WHERE kind = 'document';
      CREATE TABLE versions (id TEXT PRIMARY KEY, revision_id TEXT NOT NULL REFERENCES entities(id), number INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)), UNIQUE(revision_id, number));
      CREATE TABLE comments (id TEXT PRIMARY KEY, revision_id TEXT NOT NULL REFERENCES entities(id), version_id TEXT NOT NULL REFERENCES versions(id), data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE reviews (id TEXT PRIMARY KEY, revision_id TEXT NOT NULL REFERENCES entities(id), version_id TEXT NOT NULL REFERENCES versions(id), data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE activity (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, object_id TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE INDEX activity_object ON activity(object_id, sequence);
      CREATE TABLE sequences (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE idempotency (key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, status INTEGER NOT NULL, body TEXT NOT NULL CHECK(json_valid(body)), created_at TEXT NOT NULL);
      PRAGMA user_version = 1;
    `);
    database.prepare('INSERT INTO entities (id, kind, data) VALUES (?, ?, ?)').run(document.id, 'document', JSON.stringify(document));
    database.prepare('INSERT INTO sequences (name, value) VALUES (?, ?)').run('document', 1);
    database.prepare('INSERT INTO idempotency (key, fingerprint, status, body, created_at) VALUES (?, ?, ?, ?, ?)').run('legacy-request', 'legacy-fingerprint', 200, JSON.stringify(document), document.updatedAt);
  } finally { database.close(); }
}

test('schema 1 migrates only the known wiki snapshot and preserves it and replay records across restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'phab-wiki-migration-'));
  const path = join(directory, 'legacy.sqlite');
  const legacy: WikiDocument = { id: 'W1', title: 'Existing knowledge', slug: 'research/existing', content: 'The only stored draft.', version: 7, createdAt: '2025-03-01T12:00:00.000Z', updatedAt: '2025-03-07T15:30:00.000Z' };
  createLegacyDatabase(path, legacy);
  let store = createStore({ path });
  try {
    assert.equal(store.fresh, false);
    assert.equal((store.database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 19);
    const detail = store.documentDetail('W1');
    assert.deepEqual(detail.document, legacy);
    assert.equal(detail.history.firstAvailableVersion, 7);
    assert.equal(detail.history.nextBefore, null);
    assert.equal(detail.history.versions.length, 1);
    const known = store.documentVersion('W1', 7);
    assert.equal(known.kind, 'legacy'); assert.equal(known.author, null);
    assert.equal(known.createdAt, legacy.updatedAt); assert.equal(known.content, legacy.content);
    assert.equal(known.restoredFrom, null); assert.match(known.message, /Earlier history is unavailable/);
    assert.deepEqual(store.activities('W1'), []);
    assert.throws(() => store.documentVersion('W1', 1), /was not found/);
    assert.deepEqual(store.replay('legacy-request', 'legacy-fingerprint'), { status: 200, body: legacy });
    const edited = store.updateDocument('W1', { title: 'Current knowledge', slug: legacy.slug, content: 'A preserved new draft.', expectedVersion: 7, message: 'First recorded edit' });
    assert.equal(edited.version, 8);
    assert.deepEqual(store.documentVersion('W1', 7), known);
    assert.equal(store.documentVersion('W1', 8).kind, 'edit');
    assert.equal(store.documentVersion('W1', 8).author, 'You');
    store.close(); store = createStore({ path });
    assert.equal(store.fresh, false);
    assert.deepEqual(store.documentVersion('W1', 7), known);
    assert.deepEqual(store.documentDetail('W1').document, edited);
    assert.deepEqual(store.documentHistory('W1').versions.map(version => version.number), [8, 7]);
    assert.equal(store.documentHistory('W1').firstAvailableVersion, 7);
    assert.equal(store.createDocument({ title: 'Next document', slug: 'next', content: '' }).id, 'W2');
    assert.throws(() => store.database.prepare('UPDATE wiki_versions SET data = data WHERE document_id = ?').run('W1'), /immutable/);
    assert.throws(() => store.database.prepare('DELETE FROM wiki_versions WHERE document_id = ?').run('W1'), /immutable/);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('wiki reads expose exact snapshots and bounded exclusive-cursor history without full content', async () => {
  const app = await start();
  try {
    const create = await app.request<WikiDocument>('/api/documents', 'POST', { title: 'Draft 1', slug: 'draft/one', content: 'Content 1', message: 'Beginning' });
    assert.equal(create.status, 201); const id = create.body.id;
    for (let version = 2; version <= 25; version += 1) {
      assert.equal((await app.request(`/api/documents/${id}`, 'PUT', { title: `Draft ${version}`, slug: version === 2 ? 'draft/two' : 'draft/current', content: `Content ${version}`, expectedVersion: version - 1, message: `Edit ${version}` })).status, 200);
    }
    const detail = (await app.request<WikiDetail>(`/api/documents/${id}`)).body;
    assert.equal(detail.document.content, 'Content 25'); assert.equal(detail.document.version, 25);
    assert.equal(detail.history.versions.length, 20); assert.equal(detail.history.nextBefore, 6);
    assert.equal(detail.history.firstAvailableVersion, 1); assert.equal(detail.activity.length, 25);
    assert.deepEqual(detail.history.versions.map(version => version.number), Array.from({ length: 20 }, (_, index) => 25 - index));
    assert.ok(detail.history.versions.every(version => !Object.hasOwn(version, 'content')));
    const older = (await app.request<WikiHistory>(`/api/documents/${id}/history?before=6&limit=3`)).body;
    assert.deepEqual(older.versions.map(version => version.number), [5, 4, 3]); assert.equal(older.nextBefore, 3);
    const last = (await app.request<WikiHistory>(`/api/documents/${id}/history?before=3&limit=100`)).body;
    assert.deepEqual(last.versions.map(version => version.number), [2, 1]); assert.equal(last.nextBefore, null);
    const empty = (await app.request<WikiHistory>(`/api/documents/${id}/history?before=1`)).body;
    assert.deepEqual(empty.versions, []); assert.equal(empty.nextBefore, null); assert.equal(empty.firstAvailableVersion, 1);
    const first = (await app.request<WikiVersion>(`/api/documents/${id}/versions/1`)).body;
    const second = (await app.request<WikiVersion>(`/api/documents/${id}/versions/2`)).body;
    assert.equal(first.kind, 'create'); assert.equal(first.message, 'Beginning'); assert.equal(first.content, 'Content 1'); assert.equal(first.slug, 'draft/one');
    assert.equal(second.kind, 'edit'); assert.equal(second.content, 'Content 2'); assert.equal(second.slug, 'draft/two');
    assert.notEqual(first.id, second.id); assert.equal(first.documentId, id); assert.equal(second.documentId, id);
    const state = (await app.request<AppState>('/api/state')).body;
    assert.equal(state.documents.length, 1); assert.equal(state.documents[0]!.content, 'Content 25');
    for (const query of ['before=0', 'before=-1', 'before=1.5', 'before=1oops', 'before=9007199254740992', 'limit=0', 'limit=101', 'limit=', 'before=1&before=2', 'limit=1&limit=2', 'unknown=1']) {
      assert.equal((await app.request(`/api/documents/${id}/history?${query}`)).status, 400, query);
    }
    for (const route of [`${id}/versions/0`, `${id}/versions/nope`, `${id}/versions/9007199254740992`, `${id}/versions/1?other=2`, `${id}?before=1`]) assert.equal((await app.request(`/api/documents/${route}`)).status, 400, route);
    for (const route of [`${id}/versions/26`, 'W404', 'W404/history', 'W404/versions/1']) assert.equal((await app.request(`/api/documents/${route}`)).status, 404, route);
  } finally { await app.close(); }
});

test('wiki restoration appends current-slug content with stale checks and persistent idempotency', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'phab-wiki-restore-'));
  const databasePath = join(directory, 'workspace.sqlite');
  let app = await start({ databasePath });
  try {
    const first = (await app.request<WikiDocument>('/api/documents', 'POST', { title: 'Original title', slug: 'old/location', content: 'Original content' })).body;
    const snapshot = (await app.request<WikiVersion>(`/api/documents/${first.id}/versions/1`)).body;
    const current = (await app.request<WikiDocument>(`/api/documents/${first.id}`, 'PUT', { title: 'New title', slug: 'new/location', content: 'New content', expectedVersion: 1 })).body;
    const path = `/api/documents/${first.id}/restore`; const input = { version: 1, expectedVersion: 2 };
    const responses = await Promise.all([app.request<WikiDocument>(path, 'POST', input, 'wiki-restore-once'), app.request<WikiDocument>(path, 'POST', input, 'wiki-restore-once')]);
    assert.equal(responses[0]!.status, 200); assert.deepEqual(responses[0], responses[1]);
    const restored = responses[0]!.body;
    assert.equal(restored.version, 3); assert.equal(restored.content, first.content); assert.equal(restored.title, first.title);
    assert.equal(restored.slug, current.slug); assert.equal(restored.createdAt, first.createdAt);
    assert.deepEqual((await app.request<WikiVersion>(`/api/documents/${first.id}/versions/1`)).body, snapshot);
    let detail = (await app.request<WikiDetail>(`/api/documents/${first.id}`)).body;
    const newest = detail.history.versions[0]!;
    assert.equal(newest.kind, 'restore'); assert.equal(newest.restoredFrom, 1); assert.equal(newest.author, 'You');
    assert.match(newest.message, /Restored content from version 1/);
    assert.equal(detail.activity.filter(item => item.action === 'restored').length, 1);
    assert.equal((await app.request(path, 'POST', input)).status, 409);
    assert.equal((await app.request(path, 'POST', { version: 2, expectedVersion: 3 }, 'wiki-restore-once')).status, 409);
    assert.equal((await app.request(path, 'POST', { version: 404, expectedVersion: 3 })).status, 404);
    assert.equal((await app.request(path, 'POST', { version: 2, expectedVersion: 3, message: null })).status, 400);
    assert.equal((await app.request(path, 'POST', { version: 1, expectedVersion: 3, slug: 'malicious/move' })).status, 400);
    await app.close(); app = await start({ databasePath });
    assert.deepEqual(await app.request<WikiDocument>(path, 'POST', input, 'wiki-restore-once'), responses[0]);
    detail = (await app.request<WikiDetail>(`/api/documents/${first.id}`)).body;
    assert.equal(detail.history.versions.length, 3); assert.equal(detail.activity.length, 3);
    assert.equal((await app.request<WikiVersion>(`/api/documents/${first.id}/versions/2`)).body.content, current.content);
    const chosen = await app.request<WikiDocument>(path, 'POST', { version: 2, expectedVersion: 3, message: 'Recover the second draft' });
    assert.equal(chosen.status, 200); assert.equal(chosen.body.version, 4);
    assert.equal((await app.request<WikiVersion>(`/api/documents/${first.id}/versions/4`)).body.message, 'Recover the second draft');
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('wiki conflicts and failed writes leave latest content, history, events, and replay unchanged', async () => {
  const app = await start();
  try {
    const first = (await app.request<WikiDocument>('/api/documents', 'POST', { title: 'First', slug: 'first', content: 'One' })).body;
    await app.request('/api/documents', 'POST', { title: 'Second', slug: 'occupied', content: 'Two' });
    const path = `/api/documents/${first.id}`;
    const before = (await app.request<WikiDetail>(path)).body;
    assert.equal((await app.request(path, 'PUT', { title: 'Collision', slug: 'occupied', content: 'Cannot save', expectedVersion: 1 }, 'wiki-retry')).status, 409);
    assert.deepEqual((await app.request<WikiDetail>(path)).body, before);
    const retry = await app.request<WikiDocument>(path, 'PUT', { title: 'Allowed', slug: 'allowed', content: 'Saved', expectedVersion: 1 }, 'wiki-retry');
    assert.equal(retry.status, 200); assert.equal(retry.body.version, 2);
    const competing = await Promise.all([
      app.request(path, 'PUT', { title: 'Third', slug: 'allowed', content: 'Three', expectedVersion: 2 }),
      app.request(path, 'PUT', { title: 'Other third', slug: 'allowed', content: 'Other three', expectedVersion: 2 }),
    ]);
    assert.deepEqual(competing.map(result => result.status).sort(), [200, 409]);
    const committed = (await app.request<WikiDetail>(path)).body;
    assert.equal(committed.document.version, 3); assert.equal(committed.history.versions.length, 3); assert.equal(committed.activity.length, 3);
    // Simulate an event-storage failure after both latest content and snapshot
    // were written; the entire document save must still roll back.
    app.store.database.exec("CREATE TRIGGER reject_wiki_activity BEFORE INSERT ON activity WHEN NEW.object_id = 'W1' BEGIN SELECT RAISE(ABORT, 'Simulated event failure'); END");
    assert.throws(() => app.store.updateDocument('W1', { title: 'Uncommitted', slug: 'allowed', content: 'Must roll back', expectedVersion: 3 }), /Simulated event failure/);
    assert.deepEqual((await app.request<WikiDetail>(path)).body, committed);
    app.store.database.exec('DROP TRIGGER reject_wiki_activity');
    assert.equal((await app.request(path, 'PUT', { title: 'Fourth', slug: 'allowed', content: 'Four', expectedVersion: 3 })).status, 200);
  } finally { await app.close(); }
});
