import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { ActorAttribution, Revision } from '../shared/types.ts';
import type { RevisionDependencyInput, RevisionDependencyQuery, RevisionDependencyHistoryQuery } from '../shared/revision-dependencies.ts';
import { REVISION_DEPENDENCY_LIMITS } from '../shared/revision-dependencies.ts';
import { initializeRevisionDependencies, RevisionDependencyStore, revisionDependencyInputHash } from './revision-dependencies.ts';

const actor: ActorAttribution = { principalId: 'alice', displayName: 'Alice', credentialId: 'token', requestId: 'request-1' };
const bob: ActorAttribution = { principalId: 'bob', displayName: 'Bob', credentialId: null, requestId: 'request-2' };
const visible = () => true;
function fixture(ids = ['D1', 'D2', 'D3', 'D4', 'P1', 'L1']) {
  const db = new DatabaseSync(':memory:'); db.exec("PRAGMA foreign_keys=ON; PRAGMA user_version=23; CREATE TABLE entities(id TEXT PRIMARY KEY,kind TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data))); CREATE TABLE acceptance(revision_id TEXT PRIMARY KEY,version_id TEXT,content_hash TEXT); INSERT INTO acceptance VALUES('D1','immutable-version','immutable-hash');");
  const insert = db.prepare('INSERT INTO entities(id,kind,data) VALUES(?,?,?)');
  const entity = (id: string, kind = 'revision') => {
    const data: Revision = { id, title: `Title ${id}`, summary: 'Original summary', kind: id.startsWith('P') ? 'paper' : id.startsWith('L') ? 'document' : 'code', status: 'accepted', repositoryId: null, projectId: null, currentVersion: 3, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
    insert.run(id, kind, JSON.stringify(data));
  };
  for (const id of ids) entity(id); initializeRevisionDependencies(db); const store = new RevisionDependencyStore(db);
  const input = (id: string, add: string[], remove: string[] = [], direction: 'parents' | 'children' = 'parents'): RevisionDependencyInput => ({ direction, add, remove, expectedRelationshipVersion: store.version(id), expectedAccessEpoch: 1 });
  const mutate = (id: string, add: string[], remove: string[] = [], direction: 'parents' | 'children' = 'parents') => store.mutate(id, input(id, add, remove, direction), actor);
  const snapshot = () => Object.fromEntries(['entities', 'acceptance', 'revision_dependency_versions', 'revision_dependency_operations', 'revision_dependency_edges', 'revision_dependency_transactions'].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  const seedEdges = (edges: [string, string][]) => {
    const op = mutate('D900000', ['D900001']); const insert = db.prepare('INSERT INTO revision_dependency_edges(child_id,parent_id,operation_id) VALUES(?,?,?)');
    db.exec('BEGIN'); try { for (const [child, parent] of edges) insert.run(child, parent, op.operationId); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  return { db, store, entity, input, mutate, snapshot, seedEdges, close: () => db.close() };
}

test('schema initialization is additive, repeatable and leaves existing source, acceptance and schema-version rows exact', () => {
  const f = fixture(); try {
    const before = f.snapshot(); initializeRevisionDependencies(f.db); assert.deepEqual(f.snapshot(), before);
    assert.equal(f.db.prepare('PRAGMA user_version').get()!.user_version, 23); assert.equal(f.store.version('D1'), 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM revision_dependency_versions').get()!.n, 0, 'reads do not populate baseline versions');
    assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []);
    const receipt = f.mutate('D1', ['P1']); const after = f.snapshot(); initializeRevisionDependencies(f.db); assert.deepEqual(f.snapshot(), after); assert.deepEqual(f.store.receipt(receipt.operationId).receipt, receipt);
  } finally { f.close(); }
});

test('canonical child→parent edges update all affected endpoints once and record symmetric immutable history without changing manuscript acceptance', () => {
  const f = fixture(); try {
    const source = f.snapshot(), request = f.input('D1', ['P1', 'D2']), receipt = f.store.mutate('D1', request, actor);
    assert.equal(receipt.relationshipVersion, 1); assert.deepEqual(receipt.changes.map(change => change.revisionId), ['D2', 'P1']);
    assert.deepEqual(f.db.prepare('SELECT child_id,parent_id FROM revision_dependency_edges ORDER BY parent_id').all().map(row => ({ ...row })), [{ child_id: 'D1', parent_id: 'D2' }, { child_id: 'D1', parent_id: 'P1' }]);
    for (const id of ['D1', 'D2', 'P1']) assert.equal(f.store.version(id), 1); assert.equal(f.store.version('L1'), 0);
    const own = f.store.history('D1', {}, visible).transactions; assert.equal(own.length, 2); assert.deepEqual(own.map(row => row.sequence), [2, 1]); assert.ok(own.every(row => row.relationshipVersion === 1 && row.operationId === receipt.operationId));
    for (const id of ['D2', 'P1']) { const row = f.store.history(id, {}, visible).transactions[0]!; assert.deepEqual(row.change, { direction: 'children', action: 'added', revisionId: 'D1' }); assert.deepEqual(row.attribution, actor); }
    const operation = f.store.receipt(receipt.operationId); assert.equal(f.store.receiptRevisionId(receipt.operationId), 'D1'); assert.deepEqual(operation.receipt, receipt); assert.equal(operation.inputSha256, revisionDependencyInputHash(request)); assert.deepEqual(operation.input.add, ['D2', 'P1']);
    assert.deepEqual(f.snapshot().entities, source.entities); assert.deepEqual(f.snapshot().acceptance, source.acceptance);
    assert.throws(() => f.db.prepare('UPDATE revision_dependency_operations SET data=data WHERE id=?').run(receipt.operationId), /immutable/);
    assert.throws(() => f.db.prepare('DELETE FROM revision_dependency_transactions WHERE operation_id=?').run(receipt.operationId), /immutable/);
  } finally { f.close(); }
});

test('editing children changes the inverse canonical edges while retaining source-oriented receipt and attribution', () => {
  const f = fixture(); try {
    const receipt = f.store.mutate('P1', f.input('P1', ['D1', 'L1'], [], 'children'), bob);
    assert.deepEqual(receipt.changes.map(change => [change.direction, change.revisionId]), [['children', 'D1'], ['children', 'L1']]);
    assert.deepEqual(f.store.page('P1', { direction: 'children' }, visible).revisions.map(row => row.id), ['D1', 'L1']);
    assert.deepEqual(f.store.page('D1', { direction: 'parents' }, visible).revisions.map(row => row.id), ['P1']);
    assert.deepEqual(f.store.history('L1', {}, visible).transactions[0]!.change, { direction: 'parents', action: 'added', revisionId: 'P1' });
    f.mutate('P1', ['D2'], ['D1', 'L1'], 'children'); assert.equal(f.store.version('P1'), 2);
    assert.equal(f.store.version('D1'), 2); assert.equal(f.store.version('L1'), 2); assert.equal(f.store.version('D2'), 1);
    assert.deepEqual(f.store.receipt(receipt.operationId).receipt, receipt, 'later edge changes never rewrite historical success');
  } finally { f.close(); }
});

test('full unfiltered cycle detection catches hidden intermediates and batch inversions without exposing their identities', () => {
  const f = fixture(); try {
    f.mutate('D1', ['D2']); f.mutate('D2', ['D3']); f.mutate('D3', ['P1']);
    assert.deepEqual(f.store.page('D1', { direction: 'parents' }, id => id !== 'D2').revisions, []);
    const before = f.snapshot();
    assert.throws(() => f.mutate('P1', ['D1']), error => { assert.equal((error as { code: string }).code, 'REVISION_DEPENDENCY_CYCLE'); assert.doesNotMatch((error as Error).message, /D1|D2|D3|P1/); return true; }); assert.deepEqual(f.snapshot(), before);
    assert.throws(() => f.mutate('D1', ['P1'], [], 'children'), { code: 'REVISION_DEPENDENCY_CYCLE' }); assert.deepEqual(f.snapshot(), before);
    f.mutate('D2', ['L1'], ['D3']); f.mutate('P1', ['D1']); assert.equal(f.store.version('P1'), 2);
  } finally { f.close(); }
});

test('stale pins, duplicate/no-op edges, self edges, non-revisions and malformed batches fail before any partial write', () => {
  const f = fixture(); try {
    f.entity('D9', 'task'); const old = f.input('D1', ['D2']); f.store.mutate('D1', old, actor); const before = f.snapshot();
    assert.throws(() => f.store.mutate('D1', old, actor), { code: 'REVISION_DEPENDENCIES_CHANGED' });
    for (const [add, remove, code] of [[['D2'], [], 'REVISION_DEPENDENCY_EXISTS'], [[], ['D3'], 'REVISION_DEPENDENCY_MISSING'], [['D3'], ['D4'], 'REVISION_DEPENDENCY_MISSING'], [['D1'], [], 'REVISION_DEPENDENCY_SELF'], [['D9'], [], 'REVISION_DEPENDENCY_UNAVAILABLE'], [['D9999'], [], 'REVISION_DEPENDENCY_UNAVAILABLE']] as const) { assert.throws(() => f.mutate('D1', [...add], [...remove]), { code }); assert.deepEqual(f.snapshot(), before); }
    for (const input of [{ ...f.input('D1', ['D3']), remove: ['D3'] }, { ...f.input('D1', ['D3']), add: ['D3', 'D3'] }, { ...f.input('D1', []), remove: [] }, { ...f.input('D1', ['D3']), expectedAccessEpoch: -1 }]) assert.throws(() => f.store.mutate('D1', input, actor), { status: 400 });
    assert.throws(() => f.store.mutate('D1', f.input('D1', ['D3']), { ...actor, principalId: '' }), { status: 400 }); assert.deepEqual(f.snapshot(), before);
  } finally { f.close(); }
});

test('write errors and enclosing transaction rollbacks revert the entire graph, counters, operations and inverse histories', () => {
  const f = fixture(); try {
    f.mutate('D1', ['D2']); const before = f.snapshot();
    f.db.exec("CREATE TRIGGER fail_dependency_test BEFORE INSERT ON revision_dependency_transactions WHEN NEW.revision_id='P1' BEGIN SELECT RAISE(ABORT,'injected write failure'); END;");
    assert.throws(() => f.mutate('D1', ['D3', 'P1'], ['D2']), /injected write failure/); assert.deepEqual(f.snapshot(), before); f.db.exec('DROP TRIGGER fail_dependency_test');
    f.db.exec('BEGIN'); f.mutate('D1', ['D3'], ['D2']); f.db.exec('ROLLBACK'); assert.deepEqual(f.snapshot(), before);
    const first = f.mutate('D1', ['D3'], ['D2']); assert.equal(first.relationshipVersion, 2); assert.equal(f.store.history('D1', {}, visible).transactions[0]!.sequence, 3);
  } finally { f.close(); }
});

test('pages and history filter before result limits, expose only visible continuation boundaries, and reject stale relationship pins', () => {
  const f = fixture(['D1', ...Array.from({ length: 125 }, (_, i) => `P${i + 1}`)]); try {
    for (let i = 1; i <= 125; i += 50) f.mutate('D1', Array.from({ length: Math.min(50, 126 - i) }, (_, n) => `P${i + n}`));
    const show = new Set(['P1', 'P10', 'P2', 'P25', 'P9']), seen: string[] = []; let after: string | undefined;
    do { const page = f.store.page('D1', { direction: 'parents', limit: 2, expectedRelationshipVersion: 3, ...(after ? { after } : {}) }, id => show.has(id)); seen.push(...page.revisions.map(row => row.id)); assert.ok(page.nextAfter === null || show.has(page.nextAfter)); after = page.nextAfter ?? undefined; } while (after);
    assert.deepEqual(seen, [...show].sort()); assert.deepEqual(f.store.page('D1', { direction: 'parents', limit: 2 }, () => false), { revisionId: 'D1', direction: 'parents', relationshipVersion: 3, revisions: [], nextAfter: null });
    const transactions = []; let before: number | undefined;
    do { const page = f.store.history('D1', { limit: 2, ...(before ? { before } : {}) }, id => show.has(id)); transactions.push(...page.transactions); if (page.nextBefore !== null) assert.equal(page.nextBefore, page.transactions.at(-1)!.sequence); before = page.nextBefore ?? undefined; } while (before);
    assert.equal(transactions.length, 5); assert.ok(transactions.every(row => show.has(row.change.revisionId))); assert.equal(new Set(transactions.map(row => row.id)).size, 5);
    assert.deepEqual(f.store.history('D1', {}, () => false).transactions, []); assert.equal(f.store.history('D1', {}, () => false).nextBefore, null);
    f.mutate('D1', [], ['P1']); assert.throws(() => f.store.page('D1', { direction: 'parents', expectedRelationshipVersion: 3 }, visible), { code: 'REVISION_DEPENDENCIES_CHANGED' }); assert.throws(() => f.store.history('D1', { expectedRelationshipVersion: 3 }, visible), { code: 'REVISION_DEPENDENCIES_CHANGED' });
  } finally { f.close(); }
});

test('authoritative receipts bind exact normalized inputs, attribution, source versions and all immutable inverse transactions', () => {
  const f = fixture(); try {
    const receipt = f.mutate('D1', ['D2', 'P1']), operation = f.store.receipt(receipt.operationId); assert.equal(operation.inputSha256, revisionDependencyInputHash({ ...operation.input, add: [...operation.input.add].reverse() }));
    assert.notEqual(operation.inputSha256, revisionDependencyInputHash({ ...operation.input, direction: 'children' }));
    assert.throws(() => f.store.receipt(randomUUID()), { code: 'REVISION_DEPENDENCY_UNAVAILABLE' });
    f.db.exec('DROP TRIGGER revision_dependency_operations_no_update');
    f.db.prepare('UPDATE revision_dependency_operations SET data=? WHERE id=?').run(JSON.stringify({ ...operation, attribution: bob }), receipt.operationId);
    assert.throws(() => f.store.receipt(receipt.operationId), { code: 'REVISION_DEPENDENCY_INVALID_RECEIPT' });
    f.db.prepare('UPDATE revision_dependency_operations SET data=? WHERE id=?').run(JSON.stringify(operation), receipt.operationId);
    f.db.exec('DROP TRIGGER revision_dependency_transactions_no_delete'); f.db.prepare("DELETE FROM revision_dependency_transactions WHERE operation_id=? AND revision_id='P1'").run(receipt.operationId);
    assert.throws(() => f.store.receipt(receipt.operationId), { code: 'REVISION_DEPENDENCY_INVALID_RECEIPT' });
  } finally { f.close(); }
});

test('query shapes and safe-integer version exhaustion fail without coercion or partial graph changes', () => {
  const f = fixture(); try {
    for (const query of [{ direction: ['parents'] }, { direction: 'parents', after: 'unknown' }, { direction: 'parents', limit: 0 }, { direction: 'parents', limit: 101 }]) assert.throws(() => f.store.page('D1', query as unknown as RevisionDependencyQuery, visible), { status: 400 });
    for (const query of [{ before: 0 }, { before: Number.MAX_SAFE_INTEGER + 1 }, { limit: '1' }]) assert.throws(() => f.store.history('D1', query as unknown as RevisionDependencyHistoryQuery, visible), { status: 400 });
    f.db.prepare('INSERT INTO revision_dependency_versions(revision_id,version) VALUES(?,?)').run('D1', Number.MAX_SAFE_INTEGER);
    const before = f.snapshot(); assert.throws(() => f.mutate('D1', ['D2']), { code: 'REVISION_DEPENDENCY_LIMIT' }); assert.deepEqual(f.snapshot(), before);
  } finally { f.close(); }
});

test('reachable node traversal admits the exact boundary and rejects one more; disconnected unrelated graphs do not count', () => {
  const maximum = REVISION_DEPENDENCY_LIMITS.graphNodes, f = fixture([...Array.from({ length: maximum + 1 }, (_, i) => `D${i + 1}`), 'D900000', 'D900001', 'P1', 'L1']); try {
    f.seedEdges(Array.from({ length: maximum - 1 }, (_, i) => [`D${i + 2}`, `D${i + 3}`]));
    assert.throws(() => f.mutate('D1', ['D2']), { code: 'REVISION_DEPENDENCY_LIMIT' }); assert.equal(f.store.version('D1'), 0);
    f.mutate('P1', ['L1']); assert.equal(f.store.version('P1'), 1);
    f.db.prepare('DELETE FROM revision_dependency_edges WHERE child_id=? AND parent_id=?').run(`D${maximum}`, `D${maximum + 1}`);
    assert.equal(f.mutate('D1', ['D2']).relationshipVersion, 1);
  } finally { f.close(); }
});

test('reachable edge traversal admits exactly 50000 inspected edges and rejects a larger closure atomically', () => {
  const middles = Array.from({ length: 100 }, (_, i) => `D${i + 100}`), leaves = Array.from({ length: 499 }, (_, i) => `D${i + 1000}`), f = fixture(['D1', 'D2', ...middles, ...leaves, 'D900000', 'D900001']); try {
    const edges: [string, string][] = middles.map(id => ['D2', id]); for (const middle of middles) for (const leaf of leaves) edges.push([middle, leaf]); assert.equal(edges.length, REVISION_DEPENDENCY_LIMITS.graphEdges);
    f.seedEdges(edges); assert.throws(() => f.mutate('D1', ['D2']), { code: 'REVISION_DEPENDENCY_LIMIT' }); assert.equal(f.store.version('D1'), 0);
    f.db.prepare('DELETE FROM revision_dependency_edges WHERE child_id=? AND parent_id=?').run(middles[0]!, leaves[0]!);
    assert.equal(f.mutate('D1', ['D2']).relationshipVersion, 1); assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { f.close(); }
});
