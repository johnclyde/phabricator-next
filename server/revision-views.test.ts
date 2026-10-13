import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.ts';
import { evaluateRevisionView, isRevisionViewsSnapshot, revisionViewCreateInput, revisionViewFilters, validRevisionViewResult, type RevisionViewFilters } from '../shared/revision-views.ts';
import type { AppState, Project, Revision } from '../shared/types.ts';

const filters = (patch: Partial<RevisionViewFilters> = {}): RevisionViewFilters => ({ kind: 'paper', query: '', status: 'all', projectId: null, following: false, authored: false, ...patch });
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const status = (expected: number) => (error: unknown) => typeof error === 'object' && error !== null && 'status' in error && error.status === expected;
const epoch = (store: Store) => Number(store.database.prepare("SELECT value FROM policy_meta WHERE name='epoch'").get()!.value);
function fixture() {
  const store = new Store({ path: ':memory:' }); let sequence = 0;
  const input = (name = 'My papers', patch: Partial<RevisionViewFilters> = {}) => ({ name, filters: filters(patch), expectedAccessEpoch: epoch(store) });
  const create = (name = 'My papers', patch: Partial<RevisionViewFilters> = {}, owner = 'alice', key = sha(`request-${++sequence}`)) => store.revisionViews.mutate(owner, 'create', null, input(name, patch), key, () => true);
  return { store, input, create, next: () => sha(`request-${++sequence}`), close: () => store.close() };
}

test('saved-view canonical inputs reject unsupported filters and evaluator preserves exact authorized constraints', () => {
  assert.equal(revisionViewCreateInput({ name: '  My view  ', filters: filters(), expectedAccessEpoch: 1 }).name, 'My view');
  for (const value of [{ ...filters(), reviewer: 'alice' }, filters({ query: 'x'.repeat(513) }), filters({ projectId: 'R1' }), filters({ status: 'open' as 'all' }), { ...filters(), following: 'true' }]) assert.throws(() => revisionViewFilters(value));
  for (const name of ['', ' ', 'x'.repeat(81), 'Multiline\nname', '\ud800']) assert.throws(() => revisionViewCreateInput({ name, filters: filters(), expectedAccessEpoch: 1 }));
  const project = (id: string, parentId: string | null): Project => ({
    id, parentId, kind: 'project', name: id, displayName: id, description: '', color: '#2980b9', colorKey: 'blue',
    milestoneNumber: null, depth: parentId ? 1 : 0, hierarchyVersion: 1, membershipMode: 'direct', membershipLocked: false,
    status: 'active', version: 1, icon: 'project', primarySlug: id.toLowerCase(), primarySlugSource: 'name', aliases: [],
    authorId: null, createdAt: null, updatedAt: null,
  });
  const revision = (id: string, patch: Partial<Revision> = {}): Revision => ({ id, kind: 'paper', title: 'Exact motion', summary: 'Literal [abc] evidence.', status: 'needs_review', repositoryId: null, projectId: 'PROJ2', projectIds: ['PROJ2'], currentVersion: 1, createdAt: '', updatedAt: '', authorId: 'alice', ...patch });
  const state: Pick<AppState, 'projects' | 'revisions' | 'followingRevisionIds' | 'currentPrincipalId'> = { projects: [project('PROJ1', null), project('PROJ2', 'PROJ1')], revisions: [revision('P1'), revision('P2', { authorId: 'bob' }), revision('L1', { kind: 'document' }), revision('P3', { projectIds: ['PROJ3'] })], followingRevisionIds: ['P1', 'P2'], currentPrincipalId: 'alice' };
  const query = filters({ projectId: 'PROJ1', query: '[ABC]', authored: true, following: true, status: 'needs_review' });
  assert.deepEqual(evaluateRevisionView(query, state).map(v => v.id), ['P1']);
  assert.deepEqual(evaluateRevisionView(query, { ...state, projects: state.projects.slice(1) }), []);
  assert.deepEqual(evaluateRevisionView(query, { ...state, followingRevisionIds: undefined }), []);
  assert.deepEqual(evaluateRevisionView(query, { ...state, currentPrincipalId: 'bob' }).map(v => v.id), ['P2']);
  assert.deepEqual(evaluateRevisionView(filters({ query: '.*' }), state), [], 'query is literal, never a regular expression');
});

test('owner-private records have immutable exact retries, independent versions and terminal deletion', () => {
  const f = fixture();
  try {
    const before = f.store.state({ configured: false, model: null }), input = f.input(), key = f.next();
    const first = f.store.revisionViews.mutate('alice', 'create', null, input, key, () => true), id = first.view.id;
    assert.equal(first.view.version, 1); assert.ok(validRevisionViewResult(first, 'create', input));
    assert.deepEqual(f.store.revisionViews.list('bob'), []); assert.throws(() => f.store.revisionViews.get('bob', id), status(404));
    assert.throws(() => f.store.revisionViews.mutate('bob', 'edit', id, null, f.next(), () => true), status(404));
    assert.deepEqual(f.store.state({ configured: false, model: null }), before);
    const editInput = { ...f.input('Renamed'), expectedVersion: 1 }, editKey = f.next();
    const edit = f.store.revisionViews.mutate('alice', 'edit', id, editInput, editKey, () => true);
    assert.equal(edit.view.version, 2); assert.ok(validRevisionViewResult(edit, 'edit', editInput, id));
    assert.throws(() => f.store.revisionViews.mutate('alice', 'edit', id, editInput, f.next(), () => true), status(409));
    const same = f.store.revisionViews.mutate('alice', 'edit', id, { ...editInput, expectedVersion: 2 }, f.next(), () => true);
    assert.equal(same.view.version, 3, 'a fresh identical edit still consumes its expected version');
    const deleting = { expectedVersion: 3, expectedAccessEpoch: epoch(f.store) }, deleteKey = f.next();
    const deleted = f.store.revisionViews.mutate('alice', 'delete', id, deleting, deleteKey, () => true);
    assert.equal(deleted.view.version, 4); assert.ok(deleted.deleted); assert.ok(validRevisionViewResult(deleted, 'delete', deleting, id));
    assert.deepEqual(f.store.revisionViews.list('alice'), []); assert.throws(() => f.store.revisionViews.get('alice', id), status(404));
    assert.deepEqual(f.store.revisionViews.mutate('alice', 'create', null, input, key, () => false), first);
    assert.deepEqual(f.store.revisionViews.mutate('alice', 'edit', id, editInput, editKey, () => false), edit);
    assert.deepEqual(f.store.revisionViews.mutate('alice', 'delete', id, deleting, deleteKey, () => false), deleted);
    assert.throws(() => f.store.revisionViews.mutate('alice', 'edit', id, { ...editInput, expectedVersion: 4 }, f.next(), () => true), status(409));
    assert.throws(() => f.store.revisionViews.mutate('alice', 'create', null, f.input('Changed request'), key, () => true), status(409));
    const replacement = f.create('Renamed'); assert.notEqual(replacement.view.id, id);
    const secondOwner = f.store.revisionViews.mutate('bob', 'create', null, input, key, () => true); assert.notEqual(secondOwner.view.id, id);
    assert.ok(isRevisionViewsSnapshot({ views: f.store.revisionViews.list('alice'), accessEpoch: epoch(f.store) }));
    assert.throws(() => f.store.database.prepare('DELETE FROM revision_view_records WHERE id=?').run(id), /tombstones/);
    assert.throws(() => f.store.database.prepare('UPDATE revision_view_operations SET input_sha256=?').run(sha('tamper')), /immutable/);
  } finally { f.close(); }
});

test('new or changed project selections require visibility; unchanged unavailable selections survive edits and deletion', () => {
  const f = fixture();
  try {
    assert.throws(() => f.store.revisionViews.mutate('alice', 'create', null, f.input('Hidden', { projectId: 'PROJ1' }), f.next(), () => false), status(404));
    const saved = f.create('Matter', { projectId: 'PROJ1' });
    f.store.database.exec("UPDATE policy_meta SET value=value+1 WHERE name='epoch'");
    assert.throws(() => f.store.revisionViews.mutate('alice', 'edit', saved.view.id, { ...f.input('Old access'), expectedAccessEpoch: epoch(f.store) - 1, expectedVersion: 1 }, f.next(), () => false), status(409));
    const input = { ...f.input('Renamed matter', { projectId: 'PROJ1' }), expectedVersion: 1 };
    const renamed = f.store.revisionViews.mutate('alice', 'edit', saved.view.id, input, f.next(), () => false);
    assert.equal(renamed.view.filters.projectId, 'PROJ1');
    assert.throws(() => f.store.revisionViews.mutate('alice', 'edit', saved.view.id, { ...input, expectedVersion: 2, filters: filters({ projectId: 'PROJ2' }) }, f.next(), () => false), status(404));
    assert.equal(f.store.revisionViews.get('alice', saved.view.id).version, 2);
    assert.ok(f.store.revisionViews.mutate('alice', 'delete', saved.view.id, { expectedVersion: 2, expectedAccessEpoch: epoch(f.store) }, f.next(), () => false).deleted);
  } finally { f.close(); }
});

test('view caps and case-insensitive per-kind names are atomic and owner-scoped', () => {
  const f = fixture();
  try {
    f.create('Reading'); assert.throws(() => f.create('reading'), status(409));
    f.create('READING', { kind: 'document' }); f.create('reading', {}, 'bob');
    for (let i = 2; i < 100; i++) f.create(`View ${i}`);
    const before = f.store.database.prepare('SELECT * FROM revision_view_sequence').all();
    assert.throws(() => f.create('Overflow'), status(422)); assert.equal(f.store.revisionViews.list('alice').length, 100);
    assert.deepEqual(f.store.database.prepare('SELECT * FROM revision_view_sequence').all(), before);
    const existing = f.store.revisionViews.list('alice').find(view => view.name === 'Reading')!;
    assert.throws(() => f.store.revisionViews.mutate('alice', 'edit', existing.id, { ...f.input('reading', { kind: 'document' }), expectedVersion: 1 }, f.next(), () => true), status(409));
    assert.equal(f.store.revisionViews.get('alice', existing.id).version, 1);
    f.store.revisionViews.mutate('alice', 'delete', existing.id, { expectedVersion: 1, expectedAccessEpoch: epoch(f.store) }, f.next(), () => true);
    assert.equal(f.create('reading').view.version, 1); assert.equal(f.store.revisionViews.list('alice').length, 100);
  } finally { f.close(); }
});

test('direct mutations roll back every private row and sequence when operation evidence cannot commit', () => {
  const f = fixture();
  try {
    f.store.database.exec("CREATE TRIGGER reject_view_operation BEFORE INSERT ON revision_view_operations BEGIN SELECT RAISE(ABORT,'fixture rollback'); END");
    assert.throws(() => f.create(), /fixture rollback/);
    assert.deepEqual(f.store.revisionViews.list('alice'), []);
    assert.equal(f.store.database.prepare('SELECT value FROM revision_view_sequence').get()!.value, 0);
  } finally { f.close(); }
});

function removeViews(db: DatabaseSync) { db.exec('DROP TABLE revision_view_operations; DROP TABLE revision_view_records; DROP TABLE revision_view_sequence; PRAGMA user_version=35'); }
function snapshot(db: DatabaseSync) {
  const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all() as { type: string; name: string }[];
  return { schema, rows: Object.fromEntries(schema.filter(row => row.type === 'table').map(row => [row.name, db.prepare(`SELECT rowid,* FROM "${row.name}" ORDER BY rowid`).all()])) };
}
test('schema36 adds private views while preserving every schema35 row and prior immutable proof', () => {
  const directory = mkdtempSync(join(tmpdir(), 'revision-view-migration-')), path = join(directory, 'workspace.sqlite'); let store = new Store({ path });
  try {
    store.createRevision({ title: 'Original paper', testPlan: 'Preserve it.', kind: 'paper', files: [{ path: 'paper.tex', content: 'Exact historical content.\n' }] });
    store.database.prepare('INSERT INTO idempotency(key,fingerprint,status,body,created_at) VALUES(?,?,?,?,?)').run('old', 'old-proof', 200, '{"unchanged":true}', '2026-01-01');
    removeViews(store.database); const before = snapshot(store.database); store.close(); store = new Store({ path });
    assert.equal(store.database.prepare('PRAGMA user_version').get()!.user_version, 37);
    const after = snapshot(store.database);
    for (const entry of before.schema) assert.deepEqual(after.schema.find(row => row.name === entry.name), entry);
    for (const [table, rows] of Object.entries(before.rows)) assert.deepEqual(after.rows[table], rows, table);
    assert.deepEqual(store.revisionViews.list('alice'), []);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('schema36 collisions roll back without changing schema35 and future schemas remain fenced', () => {
  const directory = mkdtempSync(join(tmpdir(), 'revision-view-failed-migration-')), path = join(directory, 'workspace.sqlite');
  try {
    const store = new Store({ path }); removeViews(store.database);
    store.database.exec('CREATE TABLE revision_view_operations(unexpected TEXT); INSERT INTO revision_view_operations VALUES(\'original\')');
    const before = snapshot(store.database); store.close();
    assert.throws(() => new Store({ path }), /Unexpected revision_view_operations schema/);
    let db = new DatabaseSync(path); assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 35); assert.deepEqual(snapshot(db), before);
    db.exec('PRAGMA user_version=38'); db.close(); assert.throws(() => new Store({ path }), /newer than/);
    db = new DatabaseSync(path); assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 38); assert.deepEqual(snapshot(db), before); db.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
