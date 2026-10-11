import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Store, gitImportInput, parseDocxImportInput } from './store.ts';
import { revisionProjectInputHash } from './revision-projects.ts';
import { revisionProjectCreationInput, revisionProjectInput, isRevisionProjectHistory, isRevisionProjectState, validRevisionProjectResult, type RevisionProjectAction, type RevisionProjectInput } from '../shared/revision-projects.ts';
import type { ActorAttribution } from '../shared/types.ts';
import type { DocxProjection } from '../shared/docx.ts';
import { lifecycleAction } from '../tests/revision-lifecycle-fixture.ts';

const alice: ActorAttribution = { principalId: 'alice', displayName: 'Alice', credentialId: 'token', requestId: 'tag-request' };
const bob: ActorAttribution = { principalId: 'bob', displayName: 'Bob', credentialId: null, requestId: 'other-request' };
const epoch = (store: Store) => store.database.prepare("SELECT value FROM policy_meta WHERE name='epoch'").get()!.value as number;
const creation = () => ({ title: 'Tagged manuscript', summary: 'Exact summary', testPlan: 'Check references.', kind: 'paper' as const, files: [{ path: 'paper.tex', content: '\ufeffSource\r\n' }] });
const input = (store: Store, id: string, action: RevisionProjectAction, projectIds: string[]): RevisionProjectInput => ({ action, projectIds, expectedProjectVersion: store.revisionProjects.state(id).version, expectedAccessEpoch: epoch(store) });
const tables = (store: Store) => (store.database.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all() as { name: string }[]).map(row => row.name);
const rows = (store: Store, names = tables(store)) => Object.fromEntries(names.map(name => [name, store.database.prepare(`SELECT rowid,* FROM "${name}" ORDER BY rowid`).all()]));
const child = (store: Store, parentId: string, name: string, kind: 'project' | 'milestone' = 'project') => { const p = store.projectChildPreview(parentId, kind); return store.createProject({ name, parentId, kind, expectedParentVersion: p.expectedParentVersion, expectedHierarchyVersion: p.expectedHierarchyVersion, expectedParentMembersVersion: p.expectedParentMembersVersion, ...(p.conversionRequired ? { confirmMembershipConversion: true } : {}) }, alice); };

test('project tags preserve every unrelated row including accepted source, evidence and author/reviewer state', () => {
  const store = new Store({ path: ':memory:' }); try {
    const a = store.createProject({ name: 'Methods' }), b = store.createProject({ name: 'Conference' }), detail = store.createRevision({ ...creation(), projectId: a.id }, alice), id = detail.revision.id;
    store.saveReview(id, 1, { provider: 'local', model: 'fixture', summary: 'Checked exact source', findings: [] }, bob); lifecycleAction(store, id, 'accept_reviewed', alice);
    const names = tables(store).filter(name => !['revision_projects', 'revision_project_baselines', 'revision_project_operations', 'revision_project_transactions'].includes(name)), before = rows(store, names), request = input(store, id, 'add', [b.id]);
    const receipt = store.revisionProjects.mutate(id, request, alice, 'a'.repeat(64));
    assert.equal(receipt.changed, true); assert.equal(receipt.tags.version, 1); assert.equal(receipt.inputSha256, revisionProjectInputHash(request)); assert.ok(validRevisionProjectResult(receipt, id, request, alice.principalId));
    assert.deepEqual(rows(store, names), before); assert.deepEqual(store.detail(id).revision.projectIds, [a.id, b.id].sort()); assert.equal(store.detail(id).revision.status, 'accepted'); assert.equal(store.detail(id).revision.projectVersion, 1);
    assert.deepEqual(store.revisionProjects.operation(receipt.operationId).receipt, receipt); assert.equal(store.revisionProjects.operation(receipt.operationId).retryKeySha256, 'a'.repeat(64));
  } finally { store.close(); }
});

test('ordered adds and replacements use complete hierarchy, sibling milestones conflict and ordinary siblings coexist', () => {
  const store = new Store({ path: ':memory:' }); try {
    const root = store.createProject({ name: 'Study' }), a = child(store, root.id, 'Methods'), b = child(store, root.id, 'Results'), m1 = child(store, root.id, 'First submission', 'milestone'), m2 = child(store, root.id, 'Revision', 'milestone'), id = store.createRevision({ ...creation(), projectIds: [root.id, a.id, b.id] }, alice).revision.id;
    assert.deepEqual(store.revisionProjects.state(id).projectIds, [a.id, b.id].sort());
    const change = (action: RevisionProjectAction, ids: string[]) => store.revisionProjects.mutate(id, input(store, id, action, ids), alice).tags.projectIds;
    assert.deepEqual(change('add', [root.id]), [root.id]); assert.deepEqual(change('add', [m1.id, m2.id]), [m2.id]); assert.deepEqual(change('set', [m2.id, m1.id]), [m1.id]);
    assert.deepEqual(change('add', [a.id, b.id]), [a.id, b.id, m1.id].sort()); assert.deepEqual(change('remove', [a.id]), [b.id, m1.id].sort()); assert.deepEqual(change('set', []), []);
    assert.notEqual(revisionProjectInputHash(input(store, id, 'add', [m1.id, m2.id])), revisionProjectInputHash(input(store, id, 'add', [m2.id, m1.id])));
  } finally { store.close(); }
});

test('no-op receipts retain original state and scoped retry identity after later source and project changes', () => {
  const store = new Store({ path: ':memory:' }); try {
    const a = store.createProject({ name: 'Original project' }), id = store.createRevision({ ...creation(), projectId: a.id }, alice).revision.id, request = input(store, id, 'add', [a.id]), before = rows(store), first = store.revisionProjects.mutate(id, request, alice, 'a'.repeat(64));
    assert.equal(first.changed, false); assert.equal(first.transaction, null); const after = rows(store); for (const table of Object.keys(before)) if (table !== 'revision_project_operations') assert.deepEqual(after[table], before[table], table);
    const second = store.revisionProjects.mutate(id, request, alice, 'b'.repeat(64)); assert.notEqual(first.operationId, second.operationId);
    const pending = input(store, id, 'remove', [a.id]); store.createVersion(id, { expectedVersion: 1, files: [{ path: 'paper.tex', content: 'Next source' }], message: 'Source only' }, alice);
    store.revisionProjects.mutate(id, pending, alice); store.updateProject(a.id, { expectedVersion: a.version, name: 'Renamed', status: 'archived' }, alice); child(store, a.id, 'New child');
    assert.deepEqual(store.revisionProjects.operation(first.operationId).receipt, first); assert.deepEqual(store.revisionProjects.operation(second.operationId).receipt, second);
    assert.equal(JSON.parse(store.database.prepare('SELECT data FROM entities WHERE id=?').get(id)!.data as string).projectId, a.id, 'source writes preserve original scalar instead of hydrated tags');
    store.createVersion(id, { expectedVersion: 2, files: [{ path: 'paper.tex', content: 'Third source' }], message: 'Preserve overlays' }, alice); const raw = JSON.parse(store.database.prepare('SELECT data FROM entities WHERE id=?').get(id)!.data as string);
    assert.equal(raw.projectId, a.id); assert.equal(raw.projectIds, undefined); assert.equal(raw.projectVersion, undefined); assert.deepEqual(store.detail(id).revision.projectIds, []); assert.equal(store.detail(id).revision.projectId, null);
  } finally { store.close(); }
});

test('archived tags remain valid and history pages have stable independent pins', () => {
  const store = new Store({ path: ':memory:' }); try {
    const project = store.createProject({ name: 'Archived cohort' }); store.updateProject(project.id, { expectedVersion: project.version, status: 'archived' }, alice);
    const id = store.createRevision(creation(), alice).revision.id; for (const action of ['add', 'remove', 'add'] as const) store.revisionProjects.mutate(id, input(store, id, action, [project.id]), alice);
    const first = store.revisionProjects.history(id, { limit: 2, expectedProjectVersion: 3 }); assert.deepEqual(first.transactions.map(t => t.projectVersion), [3, 2]); assert.equal(first.nextBefore, 2); assert.ok(isRevisionProjectHistory({ ...first, accessEpoch: epoch(store) }, id));
    const last = store.revisionProjects.history(id, { before: first.nextBefore!, limit: 2 }); assert.deepEqual(last.transactions.map(t => t.projectVersion), [1]); assert.equal(last.nextBefore, null);
    assert.deepEqual(store.revisionProjects.historicalState(id, 0).projectIds, []); assert.deepEqual(store.revisionProjects.historicalState(id, 1).projectIds, [project.id]); assert.deepEqual(store.revisionProjects.historicalState(id, 2).projectIds, []);
    assert.throws(() => store.revisionProjects.historicalState(id, 4), { code: 'REVISION_PROJECT_INVALID_RECEIPT' });
    assert.throws(() => store.revisionProjects.history(id, { expectedProjectVersion: 2 }), { code: 'REVISION_PROJECT_CHANGED' });
  } finally { store.close(); }
});

test('pins, unknown refs, malformed inputs and injected transaction failure roll back everything', () => {
  const store = new Store({ path: ':memory:' }); try {
    const project = store.createProject({ name: 'Known' }), id = store.createRevision(creation(), alice).revision.id, request = input(store, id, 'add', [project.id]), before = rows(store);
    for (const bad of [{ ...request, expectedProjectVersion: 99 }, { ...request, expectedAccessEpoch: 99 }, { ...request, projectIds: ['PROJ999'] }, { ...request, projectIds: [project.id, project.id] }, { ...request, unexpected: true }]) { assert.throws(() => store.revisionProjects.mutate(id, bad, alice)); assert.deepEqual(rows(store), before); }
    store.database.exec("CREATE TRIGGER reject_project_transaction BEFORE INSERT ON revision_project_transactions BEGIN SELECT RAISE(ABORT,'Injected tag failure'); END");
    assert.throws(() => store.revisionProjects.mutate(id, request, alice), /Injected/); assert.deepEqual(rows(store), before);
    assert.throws(() => store.revisionProjects.mutate(id, request, { ...alice, principalId: '' })); assert.throws(() => store.revisionProjects.mutate(id, request, alice, 'not-a-hash'));
  } finally { store.close(); }
});

test('immutable operation reconstruction rejects forged input, actor, state, hierarchy, key shape and receipts', () => {
  const store = new Store({ path: ':memory:' }); try {
    const root = store.createProject({ name: 'Root' }), tag = child(store, root.id, 'Child'), id = store.createRevision({ ...creation(), projectId: root.id }, alice).revision.id, request = input(store, id, 'add', [tag.id]), receipt = store.revisionProjects.mutate(id, request, alice);
    const original = store.revisionProjects.operation(receipt.operationId), serialized = JSON.stringify(original); assert.throws(() => store.database.exec('UPDATE revision_project_operations SET data=data'), /immutable/); assert.throws(() => store.database.exec('DELETE FROM revision_project_transactions'), /immutable/);
    store.database.exec('DROP TRIGGER revision_project_operations_no_update');
    const variants = [ { ...original, attribution: bob }, { ...original, hierarchy: [] }, { ...original, before: { ...original.before, projectIds: [] } }, { ...original, receipt: { ...receipt, tags: { ...receipt.tags, projectIds: [] } } }, { ...original, retryKeySha256: 'bad' }, { ...original, unexpected: true } ];
    const wrong = { ...original, input: { ...request, action: 'remove' as const } }; wrong.inputSha256 = revisionProjectInputHash(wrong.input); wrong.receipt = { ...receipt, inputSha256: wrong.inputSha256 }; variants.push(wrong);
    for (const variant of variants) { store.database.prepare('UPDATE revision_project_operations SET input_sha256=?,data=? WHERE id=?').run(variant.inputSha256, JSON.stringify(variant), receipt.operationId); assert.throws(() => store.revisionProjects.operation(receipt.operationId), { code: 'REVISION_PROJECT_INVALID_RECEIPT' }); }
    store.database.prepare('UPDATE revision_project_operations SET input_sha256=?,data=? WHERE id=?').run(original.inputSha256, serialized, receipt.operationId); assert.deepEqual(store.revisionProjects.operation(receipt.operationId), original);
    store.database.prepare('UPDATE revision_projects SET data=json_set(data,\'$.projectIds\',json(\'[]\')) WHERE revision_id=?').run(id); assert.throws(() => store.revisionProjects.state(id), { code: 'REVISION_PROJECT_INVALID_RECEIPT' });
  } finally { store.close(); }
});

test('creation normalizes text and trusted Word imports; wire parsers preserve old absence and reject ambiguous fields', () => {
  const store = new Store({ path: ':memory:' }); try {
    const root = store.createProject({ name: 'Case' }), tag = child(store, root.id, 'Motion');
    for (const kind of ['code', 'paper', 'document'] as const) { const r = store.createRevision({ ...creation(), kind, projectIds: [root.id, tag.id] }, alice).revision; assert.deepEqual(r.projectIds, [tag.id]); assert.equal(r.projectVersion, 0); }
    const bytes = Buffer.from('trusted Word engine fixture'), file = store.files.upload({ name: 'motion.docx', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), dataBase64: bytes.toString('base64') }, alice);
    const projection: DocxProjection = { format: 'phabricator.docx.projection.v1', mainPart: 'word/document.xml', blocks: [], notes: [], comments: [], changes: [], editableRanges: [], warnings: [] };
    const word = { title: 'Motion', testPlan: 'Compare clauses.', sourceFile: { fileId: file.id, sha256: file.sha256, bytes: file.bytes }, expectedAccessEpoch: epoch(store), shareSource: false };
    const r = store.createDocxRevision({ ...word, projectIds: [root.id, tag.id] }, bytes, projection, alice).revision; assert.deepEqual(r.projectIds, [tag.id]);
    assert.equal(Object.hasOwn(parseDocxImportInput(word), 'projectIds'), false); assert.equal(Object.hasOwn(parseDocxImportInput(word), 'projectId'), false);
    const git = { commitId: 'a'.repeat(40), title: 'Imported', testPlan: 'Inspect source.', kind: 'code' }; assert.deepEqual(gitImportInput({ ...git, projectIds: [root.id, tag.id] }).projectIds, [root.id, tag.id]); assert.equal(Object.hasOwn(gitImportInput(git), 'projectIds'), false);
    for (const parser of [(extra: object) => store.createRevision({ ...creation(), ...extra }), (extra: object) => gitImportInput({ ...git, ...extra }), (extra: object) => parseDocxImportInput({ ...word, ...extra })]) assert.throws(() => parser({ projectId: null, projectIds: [] }), /not both/);
  } finally { store.close(); }
});

test('100-tag capacity applies after hierarchy normalization and failures do not partially write', () => {
  const store = new Store({ path: ':memory:' }); try {
    const ids = Array.from({ length: 101 }, (_, i) => store.createProject({ name: `Tag ${i}` }).id), id = store.createRevision({ ...creation(), projectIds: ids.slice(0, 100) }, alice).revision.id, before = rows(store);
    assert.throws(() => store.revisionProjects.mutate(id, input(store, id, 'add', ids.slice(100)), alice), { code: 'REVISION_PROJECT_LIMIT' }); assert.deepEqual(rows(store), before);
    assert.throws(() => store.createRevision({ ...creation(), projectIds: ids }, alice)); assert.deepEqual(rows(store), before);
    assert.equal(store.revisionProjects.mutate(id, input(store, id, 'remove', ids.slice(0, 1)), alice).tags.projectIds.length, 99);
  } finally { store.close(); }
});

test('portable guards accept visibility-filtered receipts without hidden-state hashes but reject structural substitutions', () => {
  assert.deepEqual(revisionProjectCreationInput({}), {}); assert.deepEqual(revisionProjectCreationInput({ projectId: null }), { projectId: null });
  const store = new Store({ path: ':memory:' }); try {
    const p = store.createProject({ name: 'Hidden tag' }), id = store.createRevision(creation(), alice).revision.id, request = input(store, id, 'add', [p.id]), receipt = store.revisionProjects.mutate(id, request, alice), filtered = { ...receipt, tags: { ...receipt.tags, projectIds: [] }, transaction: { ...receipt.transaction!, after: { ...receipt.transaction!.after, projectIds: [] } } };
    assert.ok(validRevisionProjectResult(filtered, id, request, alice.principalId)); assert.equal(validRevisionProjectResult(filtered, id, request, bob.principalId), false); assert.equal(validRevisionProjectResult({ ...filtered, changed: false }, id, request), false);
    const unexpected = { ...receipt, tags: { ...receipt.tags, projectIds: ['PROJ999'] }, transaction: { ...receipt.transaction!, after: { ...receipt.transaction!.after, projectIds: ['PROJ999'] } } };
    assert.equal(validRevisionProjectResult(unexpected, id, request), false); assert.equal(validRevisionProjectResult(unexpected, id, { ...request, action: 'set' }), false); assert.equal(validRevisionProjectResult(receipt, id, { ...request, action: 'remove' }), false);
    assert.equal(isRevisionProjectState({ ...filtered.tags, hiddenCount: 1 }, id), false); assert.throws(() => revisionProjectInput({ ...request, expectedVersion: 1 }));
  } finally { store.close(); }
});

test('saved revision responses bind exact observed tags, source identity and request key across early and writer retries', () => {
  const store = new Store({ path: ':memory:' }); try {
    const first = store.createProject({ name: 'First observed state' }), second = store.createProject({ name: 'Later genuine state' });
    const created = store.mutate('creation-key', 'creation-fingerprint', () => ({ status: 201, body: store.createRevision(creation(), alice) }));
    const id = (created.body as ReturnType<Store['detail']>).revision.id;
    store.revisionProjects.mutate(id, input(store, id, 'set', [first.id]), alice);
    const source = store.mutate('source-key', 'source-fingerprint', () => ({ status: 201, body: store.createVersion(id, { expectedVersion: 1, message: 'New source observes first tags', files: [{ path: 'paper.tex', content: 'Changed source' }] }, alice) }));
    const original = structuredClone(source.body) as ReturnType<Store['detail']>;
    store.revisionProjects.mutate(id, input(store, id, 'set', [second.id]), alice);
    const genuine = store.detail(id), swapped = { ...original, revision: { ...original.revision, projectId: genuine.revision.projectId, projectIds: genuine.revision.projectIds, projectVersion: genuine.revision.projectVersion } };
    const cases = [swapped, { ...original, revision: { ...original.revision, projectIds: undefined, projectVersion: undefined } }, { ...original, revision: { ...original.revision, id: 'P999' } }, { ...original, revision: { ...original.revision, currentVersion: 1 } }, {}];
    for (const body of cases) {
      store.database.prepare('UPDATE idempotency SET body=? WHERE key=?').run(JSON.stringify(body), 'source-key');
      assert.throws(() => store.replay('source-key', 'source-fingerprint'), { code: 'REVISION_PROJECT_INVALID_RECEIPT' });
      assert.throws(() => store.mutate('source-key', 'source-fingerprint', () => { throw new Error('Must never run fresh work'); }), { code: 'REVISION_PROJECT_INVALID_RECEIPT' });
    }
    store.database.prepare('UPDATE idempotency SET body=? WHERE key=?').run(JSON.stringify(original), 'source-key'); assert.deepEqual(store.replay('source-key', 'source-fingerprint'), source);
    assert.deepEqual(store.replay('creation-key', 'creation-fingerprint'), created);
    const firstNoop = store.mutate('noop-1', 'same-fingerprint', () => ({ status: 200, body: store.detail(id) }));
    store.revisionProjects.mutate(id, input(store, id, 'set', []), alice);
    const secondNoop = store.mutate('noop-2', 'same-fingerprint', () => ({ status: 200, body: store.detail(id) }));
    store.database.prepare('UPDATE idempotency SET body=? WHERE key=?').run(JSON.stringify(secondNoop.body), 'noop-1'); assert.throws(() => store.replay('noop-1', 'same-fingerprint'), { code: 'REVISION_PROJECT_INVALID_RECEIPT' });
    store.database.prepare('UPDATE idempotency SET body=? WHERE key=?').run(JSON.stringify(firstNoop.body), 'noop-1'); assert.deepEqual(store.replay('noop-1', 'same-fingerprint'), firstNoop);
    assert.throws(() => store.database.exec('UPDATE revision_project_response_bindings SET data=data'), /immutable/); assert.throws(() => store.database.exec('DELETE FROM revision_project_response_bindings'), /immutable/);
    const bindings = store.database.prepare('SELECT data FROM revision_project_response_bindings').all().map(row => JSON.parse(row.data as string)); assert.ok(bindings.every(binding => !JSON.stringify(binding).includes('Changed source') && !JSON.stringify(binding).includes('paper.tex')));
  } finally { store.close(); }
});

test('response proof capture and idempotency insertion fail atomically without orphan source or binding rows', () => {
  const store = new Store({ path: ':memory:' }); try {
    const before = rows(store); store.database.exec("CREATE TRIGGER reject_response_proof BEFORE INSERT ON revision_project_response_bindings BEGIN SELECT RAISE(ABORT,'Injected response proof failure'); END");
    assert.throws(() => store.mutate('failed', 'fingerprint', () => ({ status: 201, body: store.createRevision(creation(), alice) })), /Injected response/); assert.deepEqual(rows(store), before);
    store.database.exec('DROP TRIGGER reject_response_proof'); store.database.exec("CREATE TRIGGER reject_idempotency_write BEFORE INSERT ON idempotency BEGIN SELECT RAISE(ABORT,'Injected idempotency failure'); END");
    assert.throws(() => store.mutate('failed', 'fingerprint', () => ({ status: 201, body: store.createRevision(creation(), alice) })), /Injected idempotency/); assert.deepEqual(rows(store), before);
  } finally { store.close(); }
});
