import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActorAttribution, Revision, RevisionVersion } from '../shared/types.ts';
import { canonicalRevisionStack, REVISION_STACK_LIMITS } from '../shared/revision-stack.ts';
import { sourceSnapshotCanonical } from '../shared/source-snapshot.ts';
import { RevisionStackStore } from './revision-stack.ts';
import { initializeRevisionDependencies, RevisionDependencyStore } from './revision-dependencies.ts';

const alice: ActorAttribution = { principalId: 'alice', displayName: 'Original Alice', credentialId: 'credential-1', requestId: 'request-1' };
const bob: ActorAttribution = { principalId: 'bob', displayName: 'Later Bob', credentialId: 'credential-2', requestId: 'request-2' };
const visible = () => true;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
function fixture(ids = ['D1', 'D2', 'D3', 'D4', 'P1', 'L1'], path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA user_version=24;
    CREATE TABLE entities(id TEXT PRIMARY KEY,kind TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)));
    CREATE TABLE versions(id TEXT PRIMARY KEY,revision_id TEXT NOT NULL REFERENCES entities(id),number INTEGER NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),UNIQUE(revision_id,number));`);
  initializeRevisionDependencies(db);
  const reader = new RevisionStackStore(db), dependencies = new RevisionDependencyStore(db);
  const version = (id: string, number = 1, attribution: ActorAttribution | undefined = alice, content = 'Original source\n') => {
    const files = [{ path: 'source.txt', content }];
    const value: RevisionVersion = { id: randomUUID(), revisionId: id, number, files, message: 'Original message', contentHash: sha(sourceSnapshotCanonical(files)), createdAt: '2026-01-01T00:00:00.000Z', ...(attribution ? { attribution } : {}) };
    db.prepare('INSERT INTO versions(id,revision_id,number,data) VALUES(?,?,?,?)').run(value.id, id, number, JSON.stringify(value));
    db.prepare("UPDATE entities SET data=json_set(data,'$.currentVersion',?) WHERE id=?").run(number, id); return value;
  };
  const entity = (id: string, attribution: ActorAttribution | undefined = alice) => {
    const value: Revision = { id, title: `Title ${id}`, summary: 'Original summary', kind: id.startsWith('P') ? 'paper' : id.startsWith('L') ? 'document' : 'code', status: 'needs_review', repositoryId: null, projectId: null, currentVersion: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
    db.prepare("INSERT INTO entities(id,kind,data) VALUES(?,'revision',?)").run(id, JSON.stringify(value)); version(id, 1, attribution); return value;
  };
  for (const id of ids) entity(id);
  const mutate = (id: string, add: string[], remove: string[] = []) => dependencies.mutate(id, { direction: 'parents', add, remove, expectedRelationshipVersion: dependencies.version(id), expectedAccessEpoch: 1 }, alice);
  const snapshot = () => ({ schema: db.prepare("SELECT type,name,sql FROM sqlite_schema ORDER BY name").all(), rows: Object.fromEntries(['entities', 'versions', 'revision_dependency_versions', 'revision_dependency_edges', 'revision_dependency_operations', 'revision_dependency_transactions'].map(table => [table, db.prepare(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all()])), version: db.prepare('PRAGMA user_version').get() });
  // Large boundary fixtures seed only edges; they do not fabricate source bodies
  // or run tens of thousands of mutation requests just to exercise read budgets.
  const seedEdges = (edges: [string, string][]) => {
    const operationId = randomUUID();
    db.prepare('INSERT INTO revision_dependency_operations(id,revision_id,input_sha256,data) VALUES(?,?,?,?)').run(operationId, ids[0]!, 'boundary-fixture', JSON.stringify({ id: operationId, revisionId: ids[0]!, inputSha256: 'boundary-fixture' }));
    const insert = db.prepare('INSERT INTO revision_dependency_edges(child_id,parent_id,operation_id) VALUES(?,?,?)');
    db.exec('BEGIN'); try { for (const [child, parent] of edges) insert.run(child, parent, operationId); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const title = (id: string, value: string) => db.prepare("UPDATE entities SET data=json_set(data,'$.title',?) WHERE id=?").run(value, id);
  const status = (id: string, value: Revision['status']) => db.prepare("UPDATE entities SET data=json_set(data,'$.status',?) WHERE id=?").run(value, id);
  return { db, reader, dependencies, entity, version, mutate, seedEdges, title, status, snapshot, close: () => db.close() };
}

test('stack includes the complete connected branch graph in stable child-before-parent order without changing source or relationships', () => {
  const f = fixture(); try {
    f.mutate('D1', ['D2', 'P1']); f.mutate('D2', ['D3']); f.mutate('P1', ['D3']);
    f.mutate('D4', ['D2', 'L1']);
    const before = f.snapshot(), stack = f.reader.read('D1', visible, 7);
    assert.deepEqual(stack.nodes.map(node => node.id), ['D1', 'D4', 'D2', 'L1', 'P1', 'D3']);
    assert.deepEqual(stack.edges, [
      { childId: 'D1', parentId: 'D2' }, { childId: 'D1', parentId: 'P1' }, { childId: 'D2', parentId: 'D3' },
      { childId: 'D4', parentId: 'D2' }, { childId: 'D4', parentId: 'L1' }, { childId: 'P1', parentId: 'D3' },
    ]);
    assert.deepEqual(stack.openParentIds, ['D2', 'P1', 'D3']);
    assert.ok(stack.nodes.every(node => node.head.number === node.currentVersion && node.relationshipVersion === f.dependencies.version(node.id)));
    assert.equal(stack.snapshotId, sha(canonicalRevisionStack(stack)));
    assert.deepEqual(f.reader.read('D1', visible, 7, stack.snapshotId), stack); assert.deepEqual(f.snapshot(), before);
    const single = f.reader.read('L1', id => id === 'L1', 7); assert.deepEqual(single.nodes.map(node => node.id), ['L1']); assert.deepEqual(single.edges, []); assert.deepEqual(single.openParentIds, []);
  } finally { f.close(); }
});

test('closed revisions remain traversable while open-parent counts exclude closed nodes, descendants, collaterals and the seed', () => {
  const f = fixture(); try {
    f.mutate('D1', ['D2']); f.mutate('D2', ['P1']); f.mutate('D3', ['D1', 'L1']);
    f.status('D2', 'closed'); f.status('P1', 'accepted'); f.status('D1', 'closed');
    const stack = f.reader.read('D1', visible, 1);
    assert.deepEqual(stack.nodes.map(node => node.id), ['D3', 'D1', 'D2', 'L1', 'P1']);
    assert.deepEqual(stack.openParentIds, ['P1']); assert.equal(stack.nodes.find(node => node.id === 'D2')!.status, 'closed');
  } finally { f.close(); }
});

test('hidden intermediates stop traversal without placeholder topology, hidden counts, metadata reads or implied bridging edges', () => {
  const f = fixture(); try {
    f.mutate('D1', ['D2']); f.mutate('D2', ['D3']); f.mutate('D4', ['D2']);
    f.db.prepare("UPDATE entities SET data=json_set(data,'$.title',NULL) WHERE id='D2'").run();
    f.db.prepare("DELETE FROM versions WHERE revision_id='D2'").run();
    const checked: string[] = [], stack = f.reader.read('D1', id => { checked.push(id); return id !== 'D2'; }, 1);
    assert.deepEqual(checked, ['D1', 'D2']); assert.deepEqual(stack.nodes.map(node => node.id), ['D1']); assert.deepEqual(stack.edges, []);
    assert.equal(JSON.stringify(stack).includes('D2'), false); assert.equal(JSON.stringify(stack).includes('D3'), false); assert.equal(JSON.stringify(stack).includes('D4'), false);
    assert.throws(() => f.reader.read('D1', () => false, 1), { code: 'REVISION_STACK_UNAVAILABLE' });
    assert.throws(() => f.reader.read('D1', visible, 1), { code: 'REVISION_STACK_INVALID' });
    f.mutate('D1', ['D3']);
    const alternative = f.reader.read('D1', id => id !== 'D2', 1);
    assert.deepEqual(alternative.nodes.map(node => node.id), ['D1', 'D3']); assert.deepEqual(alternative.edges, [{ childId: 'D1', parentId: 'D3' }]);
  } finally { f.close(); }
});

test('authors come from version one only, with null for legacy absence and no credential or request disclosure', () => {
  const f = fixture(); try {
    const head = f.version('D1', 2, bob, 'New source'); f.mutate('D1', ['P1']);
    f.db.prepare("UPDATE versions SET data=json_remove(data,'$.attribution') WHERE revision_id='P1' AND number=1").run();
    const stack = f.reader.read('D1', visible, 1), root = stack.nodes.find(node => node.id === 'D1')!;
    assert.deepEqual(root.author, { principalId: 'alice', displayName: 'Original Alice' }); assert.deepEqual(root.head, { versionId: head.id, number: 2, contentHash: head.contentHash });
    assert.equal(stack.nodes.find(node => node.id === 'P1')!.author, null);
    assert.doesNotMatch(JSON.stringify(stack), /credential-1|request-1|Later Bob|Original source|New source/);
    f.db.prepare("UPDATE versions SET data=json_set(data,'$.attribution',json(?)) WHERE revision_id='P1' AND number=1").run(JSON.stringify({ displayName: 'Forged author' }));
    assert.throws(() => f.reader.read('D1', visible, 1), { code: 'REVISION_STACK_INVALID' });
  } finally { f.close(); }
});

test('snapshot pins cover exact heads, transitive relationships, node metadata, original authors and current access epoch', () => {
  const f = fixture(); try {
    f.mutate('D1', ['D2']); f.mutate('D2', ['P1']);
    let previous = f.reader.read('D1', visible, 1);
    const check = () => { const current = f.reader.read('D1', visible, 1); assert.notEqual(current.snapshotId, previous.snapshotId); assert.throws(() => f.reader.read('D1', visible, 1, previous.snapshotId), { code: 'REVISION_STACK_CHANGED' }); previous = current; };
    const rootRelationship = f.dependencies.version('D1'); f.mutate('P1', ['L1']); check(); assert.equal(f.dependencies.version('D1'), rootRelationship);
    f.title('L1', 'Changed distant title'); check(); f.status('P1', 'closed'); check();
    f.version('L1', 2, bob, 'Later source'); check();
    f.db.prepare("UPDATE versions SET data=json_set(data,'$.attribution.displayName','Historical Author') WHERE revision_id='L1' AND number=1").run(); check();
    const nextEpoch = f.reader.read('D1', visible, 2); assert.notEqual(nextEpoch.snapshotId, previous.snapshotId);
    assert.throws(() => f.reader.read('D1', visible, 2, previous.snapshotId), { code: 'REVISION_STACK_CHANGED' });
    assert.notEqual(f.reader.read('D1', id => id !== 'L1', 1).snapshotId, previous.snapshotId);
  } finally { f.close(); }
});

test('malformed metadata, missing or mismatched immutable heads, initial attribution and graph cycles fail generically', () => {
  const variants = [
    "UPDATE entities SET data=json_set(data,'$.id','D99') WHERE id='D1'",
    "UPDATE entities SET data=json_set(data,'$.currentVersion',2) WHERE id='D1'",
    "UPDATE entities SET data=json_set(data,'$.title',json('{\"bad\":true}')) WHERE id='D1'",
    "UPDATE entities SET data=json_set(data,'$.status','missing') WHERE id='D1'",
    "UPDATE versions SET data=json_set(data,'$.id','different-id') WHERE revision_id='D1'",
    "UPDATE versions SET data=json_set(data,'$.revisionId','D2') WHERE revision_id='D1'",
    "UPDATE versions SET data=json_set(data,'$.number',2) WHERE revision_id='D1'",
    "UPDATE versions SET data=json_set(data,'$.number',json('true')) WHERE revision_id='D1'",
    "UPDATE versions SET data=json_set(data,'$.contentHash','bad-hash') WHERE revision_id='D1'",
    "UPDATE versions SET data=json_set(data,'$.attribution',NULL) WHERE revision_id='D1'",
    "UPDATE versions SET data=json_set(data,'$.attribution.displayName',json('[]')) WHERE revision_id='D1'",
    "DELETE FROM versions WHERE revision_id='D1'",
  ];
  for (const sql of variants) { const f = fixture(); try { f.db.exec(sql); assert.throws(() => f.reader.read('D1', visible, 1), { code: 'REVISION_STACK_INVALID' }, sql); } finally { f.close(); } }
  const f = fixture(); try {
    f.version('D1', 2); f.db.prepare("DELETE FROM versions WHERE revision_id='D1' AND number=1").run(); assert.throws(() => f.reader.read('D1', visible, 1), { code: 'REVISION_STACK_INVALID' });
    f.seedEdges([['D2', 'D3'], ['D3', 'D2']]); assert.throws(() => f.reader.read('D2', visible, 1), error => { assert.equal((error as { code: string }).code, 'REVISION_STACK_INVALID'); assert.doesNotMatch((error as Error).message, /D2|D3/); return true; });
    assert.throws(() => f.reader.read('D9999', visible, 1), { code: 'REVISION_STACK_UNAVAILABLE' });
    for (const epoch of [-1, NaN, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => f.reader.read('D2', visible, epoch), { status: 400 });
    assert.throws(() => f.reader.read('D2', visible, 1, 'not-a-digest'), { status: 400 });
  } finally { f.close(); }
});

test('the visible-node bound admits exactly 1000 connected revisions and rejects an additional node without partial results', () => {
  const ids = Array.from({ length: REVISION_STACK_LIMITS.nodes + 1 }, (_, i) => `D${i + 1}`), f = fixture(ids);
  try {
    f.seedEdges(ids.slice(0, -2).map((id, i) => [id, ids[i + 1]!]));
    const stack = f.reader.read('D1', visible, 1); assert.equal(stack.nodes.length, 1000); assert.equal(stack.edges.length, 999);
    f.seedEdges([[ids.at(-2)!, ids.at(-1)!]]); assert.throws(() => f.reader.read('D1', visible, 1), { code: 'REVISION_STACK_LIMIT' });
    assert.equal(f.reader.read('D1', id => id !== ids.at(-1), 1).nodes.length, 1000);
  } finally { f.close(); }
});

test('the unique visible-edge bound admits exactly 5000 edges independently of duplicate incident scans', () => {
  const children = Array.from({ length: 50 }, (_, i) => `D${i + 1}`), parents = Array.from({ length: 100 }, (_, i) => `P${i + 1}`), f = fixture([...children, ...parents, 'L1']);
  try {
    f.seedEdges(children.flatMap(child => parents.map(parent => [child, parent] as [string, string])));
    const stack = f.reader.read('D1', visible, 1); assert.equal(stack.edges.length, 5000); assert.equal(stack.nodes.length, 150);
    f.seedEdges([['D1', 'L1']]); assert.throws(() => f.reader.read('D1', visible, 1), { code: 'REVISION_STACK_LIMIT' });
  } finally { f.close(); }
});

test('candidate policy checks are memoized per read and bounded, with a fresh authority decision on subsequent reads', () => {
  const ids = Array.from({ length: REVISION_STACK_LIMITS.candidates + 1 }, (_, i) => `D${i + 1}`), f = fixture(ids);
  try {
    f.seedEdges(ids.slice(1, -1).map(id => ['D1', id])); const calls: string[] = [];
    const stack = f.reader.read('D1', id => { calls.push(id); return id === 'D1'; }, 1); assert.equal(stack.nodes.length, 1); assert.equal(calls.length, 10_000); assert.equal(new Set(calls).size, calls.length);
    f.seedEdges([['D1', ids.at(-1)!]]); const attempts: string[] = [];
    assert.throws(() => f.reader.read('D1', id => { attempts.push(id); return id === 'D1'; }, 1), { code: 'REVISION_STACK_LIMIT' }); assert.equal(attempts.length, 10_000);
    assert.throws(() => f.reader.read('D1', () => false, 1), { code: 'REVISION_STACK_UNAVAILABLE' });
  } finally { f.close(); }
});

test('incident scan limits include hidden peers even when repeated endpoints use cached policy decisions', () => {
  const sources = Array.from({ length: 6 }, (_, i) => `D${i + 1}`), hidden = Array.from({ length: 9000 }, (_, i) => `P${i + 1}`), f = fixture([...sources, ...hidden]);
  try {
    const chain = sources.slice(0, -1).map((id, i) => [id, sources[i + 1]!] as [string, string]);
    const hiddenEdges = sources.flatMap(source => hidden.map(parent => [source, parent] as [string, string]));
    f.seedEdges([...chain, ...hiddenEdges.slice(0, REVISION_STACK_LIMITS.scannedEdges - 10)]);
    const calls: string[] = [], stack = f.reader.read('D1', id => { calls.push(id); return id.startsWith('D'); }, 1);
    assert.equal(stack.nodes.length, 6); assert.equal(calls.length, 9006); assert.equal(stack.edges.length, 5);
    f.seedEdges([hiddenEdges[REVISION_STACK_LIMITS.scannedEdges - 10]!]); assert.throws(() => f.reader.read('D1', id => id.startsWith('D'), 1), { code: 'REVISION_STACK_LIMIT' });
  } finally { f.close(); }
});

test('canonical UTF-8 payloads admit exactly 2 MiB and fail one byte above without trimming metadata', () => {
  const ids = Array.from({ length: 1000 }, (_, i) => `D${i + 1}`), f = fixture(ids);
  try {
    f.seedEdges(ids.slice(0, -1).map((id, i) => [id, ids[i + 1]!]));
    const expected = f.reader.read('D1', visible, 1);
    for (const node of expected.nodes) { node.title = 'a'.repeat(240); node.author!.displayName = 'a'.repeat(240); }
    let remaining = REVISION_STACK_LIMITS.bytes - Buffer.byteLength(canonicalRevisionStack(expected)); assert.ok(remaining > 0);
    const fill = (value: string) => Array.from(value, char => { if (remaining >= 5) { remaining -= 5; return '\u0001'; } if (remaining > 0) { remaining--; return '\u0080'; } return char; }).join('');
    for (const node of expected.nodes) {
      node.title = fill(node.title); node.author!.displayName = fill(node.author!.displayName);
      f.title(node.id, node.title); f.db.prepare("UPDATE versions SET data=json_set(data,'$.attribution.displayName',?) WHERE revision_id=? AND number=1").run(node.author!.displayName, node.id);
    }
    assert.equal(remaining, 0); assert.equal(Buffer.byteLength(canonicalRevisionStack(expected)), REVISION_STACK_LIMITS.bytes);
    const exact = f.reader.read('D1', visible, 1); assert.equal(Buffer.byteLength(canonicalRevisionStack(exact)), REVISION_STACK_LIMITS.bytes); assert.equal(exact.snapshotId, sha(canonicalRevisionStack(expected)));
    const extra = exact.nodes.find(node => node.title.includes('a'))!; f.title(extra.id, extra.title.replace('a', '\u0080'));
    assert.throws(() => f.reader.read('D1', visible, 1), { code: 'REVISION_STACK_LIMIT' });
  } finally { f.close(); }
});

test('a stack read sees one database snapshot despite a concurrent metadata change and never writes schema or data', () => {
  const directory = mkdtempSync(join(tmpdir(), 'revision-stack-')), path = join(directory, 'stack.sqlite'), f = fixture(['D1', 'D2'], path);
  const other = new DatabaseSync(path);
  try {
    f.mutate('D1', ['D2']); const before = f.reader.read('D1', visible, 1); let changed = false;
    const during = f.reader.read('D1', id => { if (id === 'D2' && !changed) { changed = true; other.prepare("UPDATE entities SET data=json_set(data,'$.title','Concurrent title') WHERE id='D2'").run(); } return true; }, 1);
    assert.deepEqual(during, before); const after = f.reader.read('D1', visible, 1); assert.notEqual(after.snapshotId, before.snapshotId); assert.equal(after.nodes.find(node => node.id === 'D2')!.title, 'Concurrent title');
    const exact = f.snapshot(); f.reader.read('D1', visible, 1); assert.deepEqual(f.snapshot(), exact);
  } finally { other.close(); f.close(); rmSync(directory, { recursive: true, force: true }); }
});
