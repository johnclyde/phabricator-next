import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from './store.ts';
import { isRevisionStack } from '../shared/revision-stack.ts';
import type { ActorAttribution } from '../shared/types.ts';

const actor: ActorAttribution = { principalId: 'alice', displayName: 'Alice', credentialId: null, requestId: 'metadata-labels' };
const epoch = (store: Store) => Number(store.database.prepare("SELECT value FROM policy_meta WHERE name='epoch'").get()!.value);

test('current revision metadata reaches detail, workspace, related revisions and Stack without rewriting source labels or relationship versions', () => {
  const store = new Store({ path: ':memory:' });
  try {
    const create = (title: string) => store.createRevision({ kind: 'paper', title, summary: 'Original summary', testPlan: 'Read source.', files: [{ path: 'main.tex', content: 'Exact source\r\n' }] }, actor).revision.id;
    const child = create('Child'), parent = create('Original parent');
    store.revisionDependencies.mutate(child, { direction: 'parents', add: [parent], remove: [], expectedRelationshipVersion: 0, expectedAccessEpoch: epoch(store) }, actor);
    const stack = store.revisionStack.read(child, () => true, epoch(store)), relationshipVersion = store.revisionDependencies.version(child);
    const original = store.database.prepare('SELECT data FROM entities WHERE id=?').get(parent)!.data;
    const snapshot = store.revisionMetadata.snapshot(parent);
    const receipt = store.revisionMetadata.mutate(parent, { title: ' \t ', summary: 'Clarified intent', testPlan: 'Read the exact source.', message: '', expectedMetadataVersion: 0, expectedVersion: snapshot.head.number, expectedVersionId: snapshot.head.versionId, expectedContentHash: snapshot.head.contentHash, expectedConfigId: snapshot.configId, expectedAccessEpoch: epoch(store) }, actor);
    assert.equal(store.database.prepare('SELECT data FROM entities WHERE id=?').get(parent)!.data, original);
    assert.equal(store.detail(parent).revision.title, receipt.metadata.title);
    assert.equal(store.state({ configured: false, model: null }).revisions.find(item => item.id === parent)!.title, receipt.metadata.title);
    const page = store.revisionDependencies.page(child, { direction: 'parents' }, () => true);
    assert.equal(page.revisions[0]!.title, receipt.metadata.title);
    assert.equal(page.revisions[0]!.updatedAt, store.detail(parent).revision.updatedAt);
    assert.equal(store.revisionDependencies.version(child), relationshipVersion);
    const current = store.revisionStack.read(child, () => true, epoch(store));
    assert.ok(isRevisionStack(current, child));
    assert.notEqual(current.snapshotId, stack.snapshotId);
    assert.equal(current.nodes.find(node => node.id === parent)!.title, receipt.metadata.title);
    assert.equal(current.nodes.find(node => node.id === parent)!.updatedAt, page.revisions[0]!.updatedAt);
    assert.throws(() => store.revisionStack.read(child, () => true, epoch(store), stack.snapshotId), { code: 'REVISION_STACK_CHANGED' });
    store.database.prepare("UPDATE revision_metadata SET data=json_set(data,'$.title','Forged') WHERE revision_id=?").run(parent);
    assert.throws(() => store.revisionStack.read(child, () => true, epoch(store)), { code: 'REVISION_STACK_INVALID' });
    assert.throws(() => store.revisionDependencies.page(child, { direction: 'parents' }, () => true), { code: 'REVISION_DEPENDENCY_INVALID_RECEIPT' });
    assert.equal(store.revisionStack.read(child, id => id !== parent, epoch(store)).nodes.length, 1);
    assert.deepEqual(store.revisionDependencies.page(child, { direction: 'parents' }, id => id !== parent).revisions, []);
  } finally { store.close(); }
});
