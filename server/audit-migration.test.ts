import { withoutRepositoryOperationsSchema } from '../tests/migration-fixture.ts';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { GitAutomationObject } from '../shared/git-automation.ts';
import { Store } from './store.ts';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function snapshot(database: DatabaseSync) {
  const schema = database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  const tables = schema.filter(row => row.type === 'table').map(row => String(row.name));
  if (database.prepare("SELECT 1 FROM sqlite_schema WHERE name='sqlite_sequence'").get()) tables.push('sqlite_sequence');
  return { schema, rows: Object.fromEntries(tables.map(name => [name, database.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()])) };
}
function downgrade(database: DatabaseSync) {
  withoutRepositoryOperationsSchema(database).exec('DROP TABLE audit_events; DROP TABLE audit_commits; PRAGMA user_version=39');
}
function savedCommit(format: 'sha1' | 'sha256' = 'sha1'): GitAutomationObject {
  const commitId = 'a'.repeat(format === 'sha1' ? 40 : 64), id = `GC-${hash(['R1', commitId])}`;
  const person = { name: 'Saved author', email: 'saved@example.test', timestamp: '2021-06-01T00:00:00Z' };
  return { id, repositoryId: 'R1', kind: 'commit', objectFormat: format, commit: { inspectionComplete: true, files: [], commit: { id: commitId, treeId: 'b'.repeat(commitId.length), parentIds: [], author: person, committer: person, message: 'Historical commit', messageTruncated: false } }, snapshot: { objectId: id, eventId: 'historical-receive', actorId: 'historical-pusher', isNew: true, contentType: 'commit', title: 'Historical commit', body: 'Historical commit', comment: '', status: '', priority: null, authorId: null, ownerId: null, repositoryId: 'R1', projectIds: [], subscriberIds: [], reviewerIds: [], files: [], version: 1, versionId: commitId, contentHash: 'c'.repeat(64) } };
}
function insertCommit(database: DatabaseSync, value: GitAutomationObject, fingerprint = hash(value)) {
  database.prepare('INSERT INTO git_automation_objects VALUES(?,?,?,?,?)').run(value.id, value.repositoryId, value.kind, fingerprint, JSON.stringify(value));
}

test('schema40 preserves every schema39 schema object and row, adds empty Audit tables and reopens unchanged', () => {
  const directory = mkdtempSync(join(tmpdir(), 'audit-migration-')), path = join(directory, 'workspace.sqlite');
  let store = new Store({ path });
  try {
    store.createRepository({ name: 'Preserved source', description: 'Keep exact bytes', remoteUrl: 'https://example.invalid/source.git', defaultBranch: 'main' });
    downgrade(store.database);
    store.database.exec("CREATE TABLE operator_notes(note TEXT); INSERT INTO operator_notes VALUES('Keep exact operator data');");
    const before = snapshot(store.database);
    store.close(); store = new Store({ path });
    const after = snapshot(store.database);
    assert.equal(store.database.prepare('PRAGMA user_version').get()!.user_version, 46);
    for (const item of before.schema) assert.deepEqual(after.schema.find(row => row.name === item.name), item);
    for (const [table, rows] of Object.entries(before.rows)) assert.deepEqual(after.rows[table], rows, table);
    assert.deepEqual(after.rows.audit_commits, []);
    assert.deepEqual(after.rows.audit_events, []);
    assert.deepEqual(store.database.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(store.database.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
    store.close(); store = new Store({ path });
    assert.deepEqual(snapshot(store.database), after);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('schema40 backfills saved SHA-1 and SHA-256 commit sources without rewriting prior data or generating audit requests', () => {
  const directory = mkdtempSync(join(tmpdir(), 'audit-backfill-')), path = join(directory, 'workspace.sqlite');
  let store = new Store({ path });
  try {
    downgrade(store.database);
    const commits = [savedCommit('sha1'), savedCommit('sha256')];
    for (const commit of commits) insertCommit(store.database, commit);
    const before = snapshot(store.database);
    store.close(); store = new Store({ path });
    const after = snapshot(store.database);
    for (const item of before.schema) assert.deepEqual(after.schema.find(row => row.name === item.name), item);
    for (const [table, rows] of Object.entries(before.rows)) {
      if (table === 'sqlite_sequence') {
        assert.deepEqual(after.rows[table]!.filter(row => !['audit_commits', 'audit_events'].includes(String(row.name))), rows);
      } else assert.deepEqual(after.rows[table], rows, table);
    }
    assert.equal(after.rows.audit_commits!.length, 2);
    for (const row of after.rows.audit_commits!) {
      const audit = JSON.parse(String(row.data)), original = commits.find(commit => commit.id === audit.id)!;
      assert.equal(audit.status, 'none'); assert.equal(audit.version, 1); assert.deepEqual(audit.auditors, []);
      assert.deepEqual(audit.source, { repositoryId: original.repositoryId, objectFormat: original.objectFormat, commit: original.commit!.commit });
    }
    assert.ok(after.rows.audit_events!.every(row => { const event = JSON.parse(String(row.data)); return event.action === 'observed' && event.actorId === 'historical-pusher' && event.origin === 'receive'; }));
    store.close(); store = new Store({ path });
    assert.deepEqual(snapshot(store.database), after);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

for (const [name, sql] of Object.entries({
  table: "CREATE TABLE audit_commits(operator_data TEXT); INSERT INTO audit_commits VALUES('keep');",
  constraints: 'CREATE TABLE audit_commits(sequence INTEGER,id TEXT,repository_id TEXT,source TEXT,data TEXT);',
  index: 'CREATE INDEX audit_events_commit ON entities(kind);',
  trigger: 'CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON entities BEGIN SELECT 1; END;',
})) test(`schema40 rejects an incompatible Audit ${name} without changing schema39 data`, () => {
  const directory = mkdtempSync(join(tmpdir(), 'audit-collision-')), path = join(directory, 'workspace.sqlite');
  const store = new Store({ path }); let database: DatabaseSync | undefined;
  try {
    downgrade(store.database); store.database.exec(sql);
    const before = snapshot(store.database); store.close();
    assert.throws(() => new Store({ path }), /Unexpected audit_.*schema/);
    database = new DatabaseSync(path);
    assert.equal(database.prepare('PRAGMA user_version').get()!.user_version, 39);
    assert.deepEqual(snapshot(database), before);
  } finally { try { store.close(); } catch {} database?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('schema40 rolls back the entire migration when a saved commit has unverifiable source evidence', () => {
  const directory = mkdtempSync(join(tmpdir(), 'audit-corrupt-migration-')), path = join(directory, 'workspace.sqlite');
  const store = new Store({ path }); let database: DatabaseSync | undefined;
  try {
    downgrade(store.database);
    insertCommit(store.database, savedCommit('sha1'));
    insertCommit(store.database, savedCommit('sha256'), 'invalid-fingerprint');
    const before = snapshot(store.database); store.close();
    assert.throws(() => new Store({ path }), /cannot verify/);
    database = new DatabaseSync(path);
    assert.equal(database.prepare('PRAGMA user_version').get()!.user_version, 39);
    assert.deepEqual(snapshot(database), before);
  } finally { try { store.close(); } catch {} database?.close(); rmSync(directory, { recursive: true, force: true }); }
});
