import { lifecycleAction, closeRevision } from '../tests/revision-lifecycle-fixture.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp } from './app.ts';
import { createAuth } from './auth.ts';
import { Store } from './store.ts';
import { registerFilePolicy } from './policy.ts';
import { canonicalRevisionStack, isRevisionStack, type RevisionStack } from '../shared/revision-stack.ts';

const workspace = { kind: 'workspace' as const }, members = (...principalIds: string[]) => ({ kind: 'principals' as const, principalIds });
type ErrorBody = { error: string; code?: string };
async function start(basePath = '/') {
  const store = new Store({ path: ':memory:' });
  const provision = createAuth({ database: store.database, mode: 'local', basePath: '/', provisioning: true });
  const alice = await provision.createAccount({ username: 'alice', displayName: 'Original Author', password: 'Alice revision stack password' });
  const bob = await provision.createAccount({ username: 'bob', displayName: 'Later Editor', password: 'Bob revision stack password' });
  const app = createApp({ store, seed: false, authMode: 'password', basePath });
  const tokens = { alice: app.auth.createToken(alice.id, { name: 'Alice', scopes: ['read', 'write'] }), reader: app.auth.createToken(bob.id, { name: 'Reader', scopes: ['read'] }), writer: app.auth.createToken(bob.id, { name: 'Writer', scopes: ['write'] }) };
  const actor = { principalId: alice.id, displayName: 'Original Author', credentialId: tokens.alice.record.id, requestId: 'stack-setup' };
  const later = { principalId: bob.id, displayName: 'Later Editor', credentialId: tokens.writer.record.id, requestId: 'later-head' };
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}${basePath.replace(/\/$/, '')}`;
  async function request<T = ErrorBody>(path: string, actorName: keyof typeof tokens | null = 'alice') { const response = await fetch(origin + path, { signal: AbortSignal.timeout(15_000), headers: actorName ? { Authorization: `Bearer ${tokens[actorName].token}` } : {} }); return { status: response.status, headers: response.headers, body: await response.json() as T }; }
  const path = (id: string) => `/api/revisions/${id}/dependencies/graph`;
  const revision = (kind: 'code' | 'paper' | 'document' = 'code', extra = {}, attribution: typeof actor | undefined = actor) => store.createRevision({ kind, title: `${kind} work`, files: [{ path: 'source.txt', content: 'Original source bytes\n' }], ...extra }, attribution);
  const link = (id: string, parents: string[], remove: string[] = []) => store.revisionDependencies.mutate(id, { direction: 'parents', add: parents, remove, expectedRelationshipVersion: store.revisionDependencies.version(id), expectedAccessEpoch: app.policies.epoch() }, actor);
  const policy = (id: string, changes: Record<string, unknown>) => { const current = app.policies.policy(id, alice.id); return app.policies.setPolicy(id, { expectedVersion: current.version, spaceId: current.spaceId, ...current.rules, ...changes }, alice.id); };
  return { ...app, store, alice, bob, actor, later, tokens, request, path, revision, link, policy, close: async () => { await app.close(); store.close(); } };
}
function databaseBytes(store: Store) {
  const tables = store.database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
  return tables.map(({ name }) => [name, store.database.prepare(`SELECT rowid,* FROM "${name}" ORDER BY rowid`).all()]);
}

for (const basePath of ['/', '/mounted/']) test(`stack API returns a complete visible D/P/L graph, original authors and immutable heads without writes at ${basePath}`, async () => {
  const app = await start(basePath);
  try {
    const root = app.revision(), parent = app.revision('paper'), grandparent = app.revision('document'), sibling = app.revision(), child = app.revision('paper');
    app.link(root.revision.id, [parent.revision.id]); app.link(parent.revision.id, [grandparent.revision.id]); app.link(sibling.revision.id, [parent.revision.id]); app.link(child.revision.id, [root.revision.id]);
    app.store.saveReview(parent.revision.id, 1, { provider: 'local', model: 'text-checks-v2', summary: 'Original review', findings: [] }, app.actor);
    lifecycleAction(app.store, parent.revision.id, 'accept_reviewed', app.actor);
    app.store.createVersion(grandparent.revision.id, { expectedVersion: 1, files: [{ path: 'source.txt', content: 'Later original source' }], message: 'New head' }, app.later);
    const before = databaseBytes(app.store), response = await app.request<RevisionStack>(app.path(root.revision.id), 'reader');
    assert.equal(response.status, 200, JSON.stringify(response.body)); assert.equal(response.headers.get('cache-control'), 'no-store');
    const graph = response.body; assert.equal(isRevisionStack(graph, root.revision.id), true);
    assert.equal(graph.snapshotId, createHash('sha256').update(canonicalRevisionStack(graph)).digest('hex'));
    assert.deepEqual(new Set(graph.nodes.map(node => node.id)), new Set([root, parent, grandparent, sibling, child].map(item => item.revision.id))); assert.equal(graph.edges.length, 4);
    assert.deepEqual(new Set(graph.openParentIds), new Set([parent.revision.id, grandparent.revision.id]));
    const changed = graph.nodes.find(node => node.id === grandparent.revision.id)!;
    assert.deepEqual(changed.author, { principalId: app.alice.id, displayName: 'Original Author' });
    assert.equal(changed.head.versionId, app.store.detail(grandparent.revision.id).versions.find(version => version.number === 2)!.id); assert.equal(changed.head.number, 2);
    assert.equal(JSON.stringify(graph).includes('Original source bytes'), false); assert.equal(JSON.stringify(graph).includes('credentialId'), false);
    assert.deepEqual((await app.request<RevisionStack>(app.path(root.revision.id) + `?expectedSnapshotId=${graph.snapshotId}`, 'reader')).body, graph);
    assert.deepEqual(databaseBytes(app.store), before, 'graph reads never create schema, counters, audit, source or retry evidence');
    assert.equal((await app.request(app.path(root.revision.id), 'writer')).status, 403); assert.equal((await app.request(app.path(root.revision.id), null)).status, 401);
  } finally { await app.close(); }
});

test('stack hashes change for transitive status, source, and graph changes while unrelated changes leave the visible snapshot stable', async () => {
  const app = await start();
  try {
    const root = app.revision(), parent = app.revision('paper'), distant = app.revision('document'), unrelated = app.revision(), extra = app.revision();
    app.link(root.revision.id, [parent.revision.id]); app.link(parent.revision.id, [distant.revision.id]);
    const read = async () => { const response = await app.request<RevisionStack>(app.path(root.revision.id)); assert.equal(response.status, 200); return response.body; };
    const first = await read(); closeRevision(app.store, unrelated.revision.id, app.actor); assert.equal((await read()).snapshotId, first.snapshotId);
    const rootRelationshipVersion = app.store.revisionDependencies.version(root.revision.id);
    closeRevision(app.store, parent.revision.id, app.actor);
    const closed = await read(); assert.notEqual(closed.snapshotId, first.snapshotId); assert.deepEqual(closed.openParentIds, [distant.revision.id], 'a closed visible intermediate does not stop ancestor traversal');
    assert.equal((await app.request(app.path(root.revision.id) + `?expectedSnapshotId=${first.snapshotId}`)).body.code, 'REVISION_STACK_CHANGED');
    app.store.createVersion(distant.revision.id, { expectedVersion: 1, files: [{ path: 'source.txt', content: 'A new distant manuscript' }], message: 'Distant source changes' }, app.later);
    const source = await read(); assert.notEqual(source.snapshotId, closed.snapshotId); assert.equal(source.nodes.find(node => node.id === distant.revision.id)!.head.number, 2);
    app.link(distant.revision.id, [extra.revision.id]); const linked = await read(); assert.notEqual(linked.snapshotId, source.snapshotId); assert.ok(linked.nodes.some(node => node.id === extra.revision.id));
    assert.equal(app.store.revisionDependencies.version(root.revision.id), rootRelationshipVersion);
    app.link(distant.revision.id, [], [extra.revision.id]); assert.notEqual((await read()).snapshotId, source.snapshotId, 'relationship history protects the restored graph against stale snapshots');
  } finally { await app.close(); }
});

test('stack traversal stops at hidden intermediates and authorizes source before parsing or checking a snapshot pin', async () => {
  const app = await start();
  try {
    const root = app.revision(), hidden = app.revision('paper', { title: 'Secret bridge' }), beyond = app.revision('document', { title: 'Visible unrelated document' });
    app.link(root.revision.id, [hidden.revision.id]); app.link(hidden.revision.id, [beyond.revision.id]);
    const full = await app.request<RevisionStack>(app.path(root.revision.id)); assert.equal(full.body.nodes.length, 3);
    app.policy(hidden.revision.id, { view: members(app.alice.id), edit: members(app.alice.id), interact: members(app.alice.id) });
    const privateGraph = await app.request<RevisionStack>(app.path(root.revision.id), 'reader'); assert.equal(privateGraph.status, 200); assert.deepEqual(privateGraph.body.nodes.map(node => node.id), [root.revision.id]); assert.deepEqual(privateGraph.body.edges, []); assert.deepEqual(privateGraph.body.openParentIds, []);
    assert.equal(JSON.stringify(privateGraph.body).includes('Secret bridge'), false); assert.equal(JSON.stringify(privateGraph.body).includes(beyond.revision.id), false);
    assert.equal((await app.request<RevisionStack>(app.path(beyond.revision.id), 'reader')).body.nodes.length, 1);
    const denied = await app.request(app.path(hidden.revision.id) + '?unexpected=private', 'reader'), missing = await app.request(app.path('P99999') + '?unexpected=private', 'reader');
    assert.equal(denied.status, 404); assert.deepEqual(denied.body, missing.body);
    assert.equal((await app.request(app.path(root.revision.id) + `?expectedSnapshotId=${full.body.snapshotId}`, 'reader')).body.code, 'REVISION_STACK_CHANGED');
    assert.equal((await app.request(app.path(root.revision.id), 'reader')).status, 200, 'hidden graph nodes never become inherited source authority');
  } finally { await app.close(); }
});

test('stack visibility follows repository, historical source File and Space ceilings and current credential authority', async () => {
  const app = await start();
  try {
    const root = app.revision(), repository = app.store.createRepository({ name: 'Source repository', remoteUrl: 'https://example.com/source.git' }, app.actor), code = app.revision('code', { repositoryId: repository.id });
    const bytes = Buffer.from('%PDF-1.4\nOriginal private figure');
    const file = app.store.files.upload({ name: 'figure.pdf', dataBase64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }, app.actor); registerFilePolicy(app.store.database, file.id, app.alice.id);
    const paper = app.revision('paper', { assets: [{ path: 'figure.pdf', fileId: file.id, sha256: file.sha256, bytes: file.bytes, mediaType: 'application/pdf' }], shareAssets: true });
    app.store.createVersion(paper.revision.id, { expectedVersion: 1, expectedVersionId: paper.versions[0]!.id, expectedContentHash: paper.versions[0]!.contentHash, expectedAccessEpoch: app.policies.epoch(), files: [{ path: 'source.txt', content: 'Figure removed from current head' }], assets: [], message: 'Keep historical source' }, app.actor);
    app.link(root.revision.id, [code.revision.id, paper.revision.id]);
    assert.equal((await app.request<RevisionStack>(app.path(root.revision.id), 'reader')).body.nodes.length, 3);
    app.policy(repository.id, { view: members(app.alice.id), edit: members(app.alice.id), interact: members(app.alice.id) });
    const space = app.policies.createSpace({ name: 'Historical File ceiling', view: members(app.alice.id), edit: members(app.alice.id) }, app.alice.id); app.policy(file.id, { spaceId: space.id });
    const graph = await app.request<RevisionStack>(app.path(root.revision.id), 'reader'); assert.deepEqual(graph.body.nodes.map(node => node.id), [root.revision.id]);
    app.auth.revokeToken(app.bob.id, app.tokens.reader.record.id);
    assert.equal((await app.request(app.path(root.revision.id), 'reader')).status, 401);
  } finally { await app.close(); }
});

test('stack transport rejects ambiguous pins and preserves unknown legacy authors', async () => {
  const app = await start();
  try {
    const old = app.store.createRevision({ kind: 'document', title: 'Legacy unattributed source', files: [{ path: 'old.txt', content: 'Original legacy source' }] });
    const path = app.path(old.revision.id), response = await app.request<RevisionStack>(path); assert.equal(response.status, 200); assert.equal(response.body.nodes[0]!.author, null);
    for (const suffix of ['?expectedSnapshotId=', '?expectedSnapshotId=BAD', `?expectedSnapshotId=${'A'.repeat(64)}`, `?expectedSnapshotId=${'a'.repeat(64)}&expectedSnapshotId=${'a'.repeat(64)}`, '?limit=25', '?direction=parents']) assert.equal((await app.request(path + suffix)).status, 400, suffix);
    const stale = await app.request(path + `?expectedSnapshotId=${'a'.repeat(64)}`); assert.equal(stale.status, 409); assert.equal(stale.body.code, 'REVISION_STACK_CHANGED');
  } finally { await app.close(); }
});
