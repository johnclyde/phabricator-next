import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.ts';
import type { ActorAttribution } from '../shared/types.ts';

function snapshot(db: DatabaseSync) {
  const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all() as { type: string; name: string }[];
  const tables = [...schema.filter(row => row.type === 'table').map(row => row.name), 'sqlite_sequence'];
  return { schema, rows: Object.fromEntries(tables.map(name => [name, db.prepare(`SELECT rowid,* FROM "${name}" ORDER BY rowid`).all()])), foreignKeys: Object.fromEntries(tables.map(name => [name, db.prepare(`PRAGMA foreign_key_list("${name}")`).all()])) };
}
const alice: ActorAttribution = { principalId: 'alice', displayName: 'Alice', credentialId: null, requestId: 'historical-comment' };

test('schema34 is only a format fence: legacy comments, preferences, receipts and all schema objects remain exact', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mention-migration-')), path = join(directory, 'db.sqlite');
  let store = new Store({ path });
  try {
    const revision = store.createRevision({ kind: 'paper', title: 'Historical', testPlan: 'Read.', files: [{ path: 'paper.tex', content: 'Exact manuscript\r\n😀' }] }, alice);
    const input = { body: '@future please inspect this.', versionId: revision.versions[0]!.id };
    const receipt = store.mutate('old-comment', 'exact-original', () => ({ status: 201, body: store.createComment(revision.revision.id, input, alice) }));
    const task = store.createTask({ title: 'Historical task' }, alice);
    store.createTaskComment(task.id, { body: '@future' }, alice);
    const paste = store.pastes.create({ content: '\ufeffOriginal paste\r\n' }, alice);
    store.pastes.comment(paste.id, { body: '@future', contentVersion: 1 }, alice);
    store.database.exec("CREATE TABLE operator_notes(note TEXT); INSERT INTO operator_notes VALUES('Keep exact bytes'); PRAGMA user_version=33");
    const before = snapshot(store.database); store.close(); store = new Store({ path });
    assert.equal(store.database.prepare('PRAGMA user_version').get()!.user_version, 41);
    assert.deepEqual(snapshot(store.database), before);
    let resolutions = 0;
    store.configureMentions({ resolve: () => { resolutions++; return { principalId: 'future', displayName: 'Future' }; } });
    assert.deepEqual(store.mutate('old-comment', 'exact-original', () => { throw new Error('Never execute historical write again'); }), receipt);
    assert.equal(resolutions, 0); assert.equal(store.detail(revision.revision.id).comments[0]!.mentions, undefined);
    assert.deepEqual(snapshot(store.database), before);
    store.close(); store = new Store({ path }); assert.deepEqual(snapshot(store.database), before);
    assert.deepEqual(store.database.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(store.database.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
  } finally { if (store.database.isOpen) store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('a future mention schema is rejected without modifying any saved record', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mention-future-')), path = join(directory, 'db.sqlite'), store = new Store({ path });
  try {
    store.createTask({ title: 'Preserve future data' }, alice); store.database.exec('PRAGMA user_version=42');
    const before = snapshot(store.database); store.close(); assert.throws(() => new Store({ path }), /newer|schema|version/i);
    const db = new DatabaseSync(path);
    try { assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 42); assert.deepEqual(snapshot(db), before); } finally { db.close(); }
  } finally { if (store.database.isOpen) store.close(); rmSync(directory, { recursive: true, force: true }); }
});
