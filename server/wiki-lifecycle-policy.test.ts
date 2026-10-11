import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp } from './app.ts';
import { createAuth } from './auth.ts';
import { Store } from './store.ts';
import type { AppState, WikiDetail, WikiDocument, WikiVersion } from '../shared/types.ts';
import type { WikiLifecycleHistory, WikiLifecyclePins, WikiLifecycleReceipt, WikiMovePreview, WikiMoveReceipt, WikiPathResult } from '../shared/wiki.ts';

const workspace = { kind: 'workspace' as const };
const members = (...principalIds: string[]) => ({ kind: 'principals' as const, principalIds });
type Failure = { error: string; code?: string };

async function start() {
  const store = new Store({ path: ':memory:' });
  const provision = createAuth({ database: store.database, mode: 'local', basePath: '/', provisioning: true });
  const alice = await provision.createAccount({ username: 'alice', displayName: 'Alice', password: 'Alice lifecycle policy test password' });
  const bob = await provision.createAccount({ username: 'bob', displayName: 'Bob', password: 'Bob lifecycle policy test password' });
  const app = createApp({ store, seed: false, authMode: 'password' });
  const tokens = {
    alice: app.auth.createToken(alice.id, { name: 'Alice', scopes: ['read', 'write'] }),
    other: app.auth.createToken(alice.id, { name: 'Same principal retry', scopes: ['read', 'write'] }),
    bob: app.auth.createToken(bob.id, { name: 'Bob', scopes: ['read', 'write'] }),
    reader: app.auth.createToken(alice.id, { name: 'Read only', scopes: ['read'] }),
  };
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  async function request<T = Failure>(path: string, method = 'GET', input?: unknown, actor: keyof typeof tokens | null = 'alice', key?: string) {
    const response = await fetch(origin + path, { method, signal: AbortSignal.timeout(15_000), headers: { ...(actor ? { Authorization: `Bearer ${tokens[actor].token}` } : {}), ...(input === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    return { status: response.status, body: await response.json() as T };
  }
  let sequence = 0;
  function policy(id: string, patch: Record<string, unknown>, actor = alice.id) { const old = app.policies.policy(id, actor); return app.policies.setPolicy(id, { expectedVersion: old.version, spaceId: old.spaceId, ...old.rules, ...patch }, actor); }
  async function document(slug: string, title = `Page ${slug}`, content = `Published content at ${slug}`) {
    const result = await request<WikiDocument>('/api/documents', 'POST', { slug, title, content }, 'alice', `create-${++sequence}`); assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body;
  }
  async function detail(id: string, actor: keyof typeof tokens = 'alice') { const result = await request<WikiDetail>(`/api/documents/${id}`, 'GET', undefined, actor); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body; }
  async function pins(id: string): Promise<WikiLifecyclePins> {
    const current = await detail(id); assert.ok(current.document.publication);
    return { expectedVersion: current.document.version, expectedHeadVersionId: current.document.publication.headVersionId, expectedPublishedVersionId: current.document.publication.publishedVersionId, expectedPublicationRevision: current.document.publication.revision, expectedAccessEpoch: current.accessEpoch! };
  }
  async function operation(id: string, kind: 'drafts' | 'publish' | 'delete', input: Record<string, unknown> = {}, key = `lifecycle-${++sequence}`) {
    const body = { ...await pins(id), ...input }, path = `/api/documents/${id}/${kind}`;
    const result = await request<WikiLifecycleReceipt>(path, 'POST', body, 'alice', key); assert.equal(result.status, 200, JSON.stringify(result.body));
    return { receipt: result.body, body, path, key };
  }
  function versionRows(id: string) { return store.database.prepare('SELECT id,number,data FROM wiki_versions WHERE document_id=? ORDER BY number').all(id); }
  let closing: Promise<void> | undefined;
  return { ...app, tokens, alice, bob, request, policy, document, detail, pins, operation, versionRows, close: () => closing ??= (async () => { await app.close(); store.close(); })() };
}

test('wiki drafts are shared snapshots while publication selects original immutable content without allocating another version', async () => {
  const app = await start();
  try {
    await app.document('/'); const page = await app.document('article/', 'Published title', 'Published body');
    app.policy(page.id, { edit: members(app.alice.id) });
    const original = app.store.documentVersion(page.id, 1);
    const saved = await app.operation(page.id, 'drafts', { title: 'Shared draft title', content: '\ufeffShared draft body\r\n', message: 'Draft evidence' });
    assert.equal(saved.receipt.document.version, 2); assert.equal(saved.receipt.document.title, page.title); assert.equal(saved.receipt.document.content, page.content);
    assert.equal(saved.receipt.document.publication?.publishedVersionId, original.id); assert.equal(saved.receipt.document.publication?.headVersion, 2);
    const visible = await app.detail(page.id, 'bob'); assert.equal(visible.head?.content, '\ufeffShared draft body\r\n'); assert.equal(visible.head?.title, 'Shared draft title');
    const draft = app.store.documentVersion(page.id, 2); assert.equal(visible.head?.id, draft.id);
    assert.equal((await app.request(`/api/documents/${page.id}/versions/2`, 'GET', undefined, 'bob')).status, 200, 'draft content inherits ordinary document view authority');
    const state = (await app.request<AppState>('/api/state', 'GET', undefined, 'bob')).body;
    assert.equal(state.documents.find(item => item.id === page.id)?.title, page.title);
    const path = (await app.request<WikiPathResult>('/api/wiki?path=article/', 'GET', undefined, 'bob')).body; assert.equal(path.document?.title, page.title);
    assert.equal((await app.request(`/api/documents/${page.id}/publish`, 'POST', { ...await app.pins(page.id), targetVersionId: draft.id }, 'bob', 'reader-cannot-publish')).status, 403);
    const rows = app.versionRows(page.id);
    const published = await app.operation(page.id, 'publish', { targetVersionId: draft.id, message: 'Publish draft' });
    assert.deepEqual(app.versionRows(page.id), rows); assert.equal(published.receipt.document.version, 2); assert.equal(published.receipt.document.title, draft.title); assert.equal(published.receipt.document.content, draft.content);
    assert.equal(published.receipt.document.publication?.publishedVersionId, draft.id); assert.equal(published.receipt.transaction.newVersionId, null); assert.equal(published.receipt.transaction.kind, 'publish');
    const reverted = await app.operation(page.id, 'publish', { targetVersionId: original.id, message: 'Publish original' });
    assert.equal(reverted.receipt.document.version, 2); assert.equal(reverted.receipt.document.publication?.publishedVersion, 1); assert.equal(reverted.receipt.document.content, original.content); assert.deepEqual(app.versionRows(page.id), rows);
    assert.deepEqual(app.store.documentVersion(page.id, 1), original); assert.deepEqual(app.store.documentVersion(page.id, 2), draft, 'publication never rewrites content identity, author, timestamp or evidence');
    const third = await app.operation(page.id, 'drafts', { title: 'Third saved version', content: 'Another shared draft' }); assert.equal(third.receipt.document.version, 3); assert.equal(third.receipt.document.publication?.publishedVersion, 1);
  } finally { await app.close(); }
});

test('wiki delete writes an immutable blank marker, publishing keeps status separate, and restore appends and reactivates', async () => {
  const app = await start();
  try {
    await app.document('/'); const page = await app.document('recover/', 'Published heading', 'Recover this original');
    const original = app.store.documentVersion(page.id, 1);
    await app.operation(page.id, 'drafts', { title: 'Unpublished heading', content: 'Retain unpublished source' }); const draft = app.store.documentVersion(page.id, 2);
    const deleted = await app.operation(page.id, 'delete', { message: 'Soft delete' });
    assert.equal(deleted.receipt.document.location?.status, 'deleted'); assert.equal(deleted.receipt.document.version, 3); assert.equal(deleted.receipt.document.content, ''); assert.equal(deleted.receipt.document.title, page.title);
    const marker = app.store.documentVersion(page.id, 3); assert.equal(marker.kind, 'delete'); assert.equal(marker.content, ''); assert.equal(deleted.receipt.transaction.newVersionId, marker.id);
    assert.equal((await app.request(`/api/documents/${page.id}/delete`, 'POST', await app.pins(page.id), 'alice', 'repeat-delete')).status, 409);
    const republished = await app.operation(page.id, 'publish', { targetVersionId: original.id });
    assert.equal(republished.receipt.document.location?.status, 'deleted'); assert.equal(republished.receipt.document.content, original.content); assert.equal(republished.receipt.document.version, 3);
    assert.equal((await app.request(`/api/documents/${page.id}/move-preview?path=elsewhere/`)).status, 409, 'publishing old content does not reactivate document status');
    const restored = await app.request<WikiDocument>(`/api/documents/${page.id}/restore`, 'POST', { ...await app.pins(page.id), version: 1, message: 'Restore as new content' }, 'alice', 'restore-original');
    assert.equal(restored.status, 200, JSON.stringify(restored.body)); assert.equal(restored.body.version, 4); assert.equal(restored.body.location?.status, 'active'); assert.equal(restored.body.publication?.publishedVersion, 4); assert.equal(restored.body.content, original.content);
    const copy = app.store.documentVersion(page.id, 4); assert.notEqual(copy.id, original.id); assert.equal(copy.restoredFrom, 1); assert.deepEqual(app.store.documentVersion(page.id, 2), draft); assert.deepEqual(app.store.documentVersion(page.id, 3), marker);
    const history = await app.request<WikiLifecycleHistory>(`/api/documents/${page.id}/transactions?limit=2`); assert.equal(history.status, 200); assert.equal(history.body.transactions.length, 2); assert.ok(history.body.nextBefore);
    const older = await app.request<WikiLifecycleHistory>(`/api/documents/${page.id}/transactions?before=${history.body.nextBefore}&limit=2`); assert.equal(older.status, 200); assert.equal(older.body.transactions.some(item => history.body.transactions.some(recent => recent.id === item.id)), false);
    assert.equal((await app.request(`/api/documents/${page.id}/transactions?limit=101`)).status, 400);
  } finally { await app.close(); }
});

test('wiki lifecycle mutations require current credential scope, document edit, ancestor visibility and principal-scoped receipts', async () => {
  const app = await start();
  try {
    await app.document('/'); const parent = await app.document('parent/'), page = await app.document('parent/child/');
    app.policy(parent.id, { edit: members(app.bob.id) }, app.bob.id);
    const saved = await app.operation(page.id, 'drafts', { title: 'Shared draft', content: 'Shared draft body' }, 'exact-draft');
    const retry = await app.request<WikiLifecycleReceipt>(saved.path, 'POST', saved.body, 'other', saved.key); assert.equal(retry.status, 200); assert.deepEqual(retry.body.document, saved.receipt.document); assert.deepEqual(retry.body.transaction, saved.receipt.transaction);
    assert.equal((await app.request(saved.path, 'POST', saved.body, 'reader', saved.key)).status, 403);
    assert.equal((await app.request(saved.path, 'POST', saved.body, null, saved.key)).status, 401);
    assert.equal((await app.request(saved.path, 'POST', saved.body, 'bob', saved.key)).status, 409, 'another principal cannot borrow a saved receipt with stale pins');
    for (const endpoint of ['drafts', 'publish', 'delete']) {
      const input = { ...await app.pins(page.id), ...(endpoint === 'drafts' ? { title: 'Denied title', content: 'Denied content' } : endpoint === 'publish' ? { targetVersionId: saved.receipt.document.publication!.headVersionId } : {}) };
      assert.equal((await app.request(`/api/documents/${page.id}/${endpoint}`, 'POST', input, 'reader', `scope-${endpoint}`)).status, 403);
    }
    app.policy(parent.id, { view: members(app.bob.id) }, app.bob.id);
    for (const route of [`/api/documents/${page.id}`, `/api/documents/${page.id}/history`, `/api/documents/${page.id}/versions/2`, `/api/documents/${page.id}/transactions`]) assert.equal((await app.request(route)).status, 404, route);
    assert.equal((await app.request(saved.path, 'POST', saved.body, 'other', saved.key)).status, 404, 'original author has no override for ancestor revocation');
    app.policy(parent.id, { view: workspace }, app.bob.id); app.policy(page.id, { edit: members(app.bob.id) }, app.bob.id);
    assert.equal((await app.request(saved.path, 'POST', saved.body, 'other', saved.key)).status, 403, 'historical success does not retain write authority');
    app.policy(page.id, { edit: workspace }, app.bob.id); app.auth.revokeToken(app.alice.id, app.tokens.other.record.id);
    assert.equal((await app.request(saved.path, 'POST', saved.body, 'other', saved.key)).status, 401);
  } finally { await app.close(); }
});

test('wiki publication pins reject stale concurrent changes, cross-document targets and incomplete legacy writes', async () => {
  const app = await start();
  try {
    await app.document('/'); const page = await app.document('concurrent/'), other = await app.document('other/');
    const original = app.store.documentVersion(page.id, 1), foreign = app.store.documentVersion(other.id, 1);
    await app.operation(page.id, 'drafts', { title: 'Draft title', content: 'Draft body' }); const stale = await app.pins(page.id);
    const publishBody = { ...stale, targetVersionId: app.store.documentVersion(page.id, 2).id };
    const outcomes = await Promise.all([app.request(`/api/documents/${page.id}/publish`, 'POST', publishBody, 'alice', 'concurrent-one'), app.request(`/api/documents/${page.id}/publish`, 'POST', publishBody, 'alice', 'concurrent-two')]);
    assert.deepEqual(outcomes.map(item => item.status).sort(), [200, 409]); assert.equal(app.versionRows(page.id).length, 2);
    assert.equal((await app.request(`/api/documents/${page.id}/drafts`, 'POST', { ...stale, title: 'Stale', content: 'Stale' }, 'alice', 'stale-publication')).status, 409);
    assert.equal((await app.request(`/api/documents/${page.id}/publish`, 'POST', { ...await app.pins(page.id), targetVersionId: foreign.id }, 'alice', 'foreign-content')).status, 404);
    for (const [route, method, body] of [[`/api/documents/${page.id}`, 'PUT', { title: 'Unpinned write', content: 'Cannot overwrite publication state', slug: page.slug, expectedVersion: 2 }], [`/api/documents/${page.id}/restore`, 'POST', { version: 1, expectedVersion: 2 }]] as const) {
      const rejected = await app.request(route, method, body, 'alice', `legacy-${method}`); assert.ok([400, 409].includes(rejected.status), JSON.stringify(rejected.body));
    }
    assert.equal(app.versionRows(page.id).length, 2); assert.deepEqual(app.store.documentVersion(page.id, 1), original);
    const current = await app.pins(page.id);
    for (const missing of ['expectedVersion', 'expectedHeadVersionId', 'expectedPublishedVersionId', 'expectedPublicationRevision', 'expectedAccessEpoch'] as const) {
      const input: Partial<WikiLifecyclePins> & { targetVersionId: string } = { ...current, targetVersionId: original.id }; delete input[missing];
      assert.equal((await app.request(`/api/documents/${page.id}/publish`, 'POST', input, 'alice', `missing-${missing}`)).status, 400);
    }
  } finally { await app.close(); }
});

test('wiki historical receipts never borrow newer content or accept a canonical transaction for a different request', async () => {
  const app = await start();
  try {
    await app.document('/'); const page = await app.document('receipts/');
    const draft = await app.operation(page.id, 'drafts', { title: 'Receipt title', content: 'Original exact draft', message: 'Exact request' }, 'draft-receipt');
    await app.operation(page.id, 'drafts', { title: 'Later title', content: 'Later draft source' });
    const retry = await app.request<WikiLifecycleReceipt>(draft.path, 'POST', draft.body, 'other', draft.key); assert.equal(retry.status, 200); assert.deepEqual(retry.body.document, draft.receipt.document); assert.deepEqual(retry.body.transaction, draft.receipt.transaction); assert.equal(retry.body.document.publication?.headVersion, 2);
    const forged = { ...draft.body, content: 'Different source under the same receipt' };
    app.store.database.prepare("UPDATE idempotency SET fingerprint=? WHERE key LIKE '%:draft-receipt'").run(createHash('sha256').update(JSON.stringify(['POST', draft.path, forged])).digest('hex'));
    assert.equal((await app.request(draft.path, 'POST', forged, 'other', draft.key)).status, 409);
    const published = await app.operation(page.id, 'publish', { targetVersionId: app.store.documentVersion(page.id, 2).id, message: 'Exact publication' }, 'publish-receipt');
    const targetSwap = { ...published.body, targetVersionId: app.store.documentVersion(page.id, 1).id };
    app.store.database.prepare("UPDATE idempotency SET fingerprint=? WHERE key LIKE '%:publish-receipt'").run(createHash('sha256').update(JSON.stringify(['POST', published.path, targetSwap])).digest('hex'));
    assert.equal((await app.request(published.path, 'POST', targetSwap, 'other', published.key)).status, 409);
    assert.equal((await app.detail(page.id)).document.publication?.publishedVersion, 2); assert.equal(app.versionRows(page.id).length, 3);
  } finally { await app.close(); }
});

test('wiki ordinary edit receipts cannot strip publication evidence or substitute different source under a valid snapshot', async () => {
  const app = await start();
  try {
    await app.document('/'); const page = await app.document('edit-receipt/'), path = `/api/documents/${page.id}`;
    const input = { title: 'Committed title', slug: page.slug, content: 'Committed source', expectedVersion: 1, message: 'Committed request' };
    const saved = await app.request<WikiDocument>(path, 'PUT', input, 'alice', 'ordinary-receipt'); assert.equal(saved.status, 200, JSON.stringify(saved.body)); assert.ok(saved.body.publication);
    const row = app.store.database.prepare("SELECT key,body,fingerprint FROM idempotency WHERE key LIKE '%:ordinary-receipt'").get() as { key: string; body: string; fingerprint: string };
    const stripped = JSON.parse(row.body) as WikiDocument; delete stripped.publication;
    app.store.database.prepare('UPDATE idempotency SET body=? WHERE key=?').run(JSON.stringify(stripped), row.key);
    assert.equal((await app.request(path, 'PUT', input, 'other', 'ordinary-receipt')).status, 409, 'a new receipt cannot masquerade as legacy evidence');
    app.store.database.prepare('UPDATE idempotency SET body=? WHERE key=?').run(row.body, row.key);
    const different = { ...input, content: 'Uncommitted substituted source' };
    app.store.database.prepare('UPDATE idempotency SET fingerprint=? WHERE key=?').run(createHash('sha256').update(JSON.stringify(['PUT', path, different])).digest('hex'), row.key);
    assert.equal((await app.request(path, 'PUT', different, 'other', 'ordinary-receipt')).status, 409);
    assert.equal(app.store.documentVersion(page.id, 2).content, input.content); assert.equal(app.versionRows(page.id).length, 2);
  } finally { await app.close(); }
});

test('migrated legacy wiki create, edit and restore receipts retain exact historical responses without accepting substituted evidence', async () => {
  const app = await start();
  try {
    await app.document('/');
    const createInput = { title: '  Legacy original  ', slug: 'legacy-receipts/', content: 'Original source before publication pointers' };
    const created = await app.request<WikiDocument>('/api/documents', 'POST', createInput, 'alice', 'legacy-create'); assert.equal(created.status, 201);
    const page = created.body, path = `/api/documents/${page.id}`;
    const editInput = { title: '\tLegacy edited\t', slug: page.slug, content: 'Edited source before publication pointers', expectedVersion: 1 };
    assert.equal((await app.request(path, 'PUT', editInput, 'alice', 'legacy-edit')).status, 200);
    const restoreInput = { version: 1, expectedVersion: 2, message: 'Restore original source' };
    assert.equal((await app.request(`${path}/restore`, 'POST', restoreInput, 'alice', 'legacy-restore')).status, 200);
    const operations = [
      { path: '/api/documents', method: 'POST', input: createInput, key: 'legacy-create', status: 201 },
      { path, method: 'PUT', input: editInput, key: 'legacy-edit', status: 200 },
      { path: `${path}/restore`, method: 'POST', input: restoreInput, key: 'legacy-restore', status: 200 },
    ].map(operation => {
      const row = app.store.database.prepare('SELECT key,body,fingerprint FROM idempotency WHERE key LIKE ?').get(`%:${operation.key}`) as { key: string; body: string; fingerprint: string };
      const legacy = JSON.parse(row.body) as WikiDocument & { accessEpoch?: number }; delete legacy.publication;
      app.store.database.prepare('UPDATE idempotency SET body=? WHERE key=?').run(JSON.stringify(legacy), row.key);
      return { ...operation, row, legacy };
    });
    const immutableRows = app.versionRows(page.id), current = (await app.detail(page.id)).document;
    const baseline = { id: 'legacy-receipt-baseline', documentId: page.id, sequence: current.version, kind: 'legacy', actor: null, createdAt: current.updatedAt,
      message: 'Publication state preserved from the previous storage format. Earlier lifecycle transactions are unavailable.', inputSha256: null, before: null,
      after: { publication: current.publication, location: current.location, updatedAt: current.updatedAt }, newVersionId: null };
    // Emulate the schema-21 migration boundary without rewriting any preexisting
    // source evidence: it adds one baseline, not invented per-version actions.
    const triggers = app.store.database.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name IN ('wiki_transactions_no_update','wiki_transactions_no_delete') ORDER BY name").all() as { sql: string }[];
    assert.equal(triggers.length, 2);
    app.store.transaction(() => {
      app.store.database.exec('DROP TRIGGER wiki_transactions_no_update; DROP TRIGGER wiki_transactions_no_delete');
      app.store.database.prepare('DELETE FROM wiki_transactions WHERE document_id=?').run(page.id);
      app.store.database.prepare('INSERT INTO wiki_transactions(id,document_id,sequence,data) VALUES(?,?,?,?)').run(baseline.id, page.id, baseline.sequence, JSON.stringify(baseline));
      for (const trigger of triggers) app.store.database.exec(trigger.sql);
    });
    assert.deepEqual(app.versionRows(page.id), immutableRows);
    const migrated = app.store.documentTransactions(page.id); assert.equal(migrated.firstAvailableSequence, 3); assert.deepEqual(migrated.transactions, [baseline]);
    const draft = await app.operation(page.id, 'drafts', { title: 'Current published title', content: 'Current source after migration' });
    await app.operation(page.id, 'publish', { targetVersionId: draft.receipt.document.publication!.headVersionId });
    const rowsAfterPublication = app.versionRows(page.id);
    for (const operation of operations) {
      const retry = await app.request<WikiDocument & { accessEpoch?: number }>(operation.path, operation.method, operation.input, 'other', operation.key);
      assert.equal(retry.status, operation.status, JSON.stringify(retry.body));
      const { accessEpoch: _savedEpoch, ...saved } = operation.legacy;
      const { accessEpoch: _retryEpoch, ...returned } = retry.body;
      assert.deepEqual(returned, saved, 'legacy replay returns its own immutable result, not the later published head');
      const substituted = operations[operation.key === 'legacy-create' ? 1 : 0]!.legacy;
      app.store.database.prepare('UPDATE idempotency SET body=? WHERE key=?').run(JSON.stringify(substituted), operation.row.key);
      assert.equal((await app.request(operation.path, operation.method, operation.input, 'other', operation.key)).status, 409, 'another canonical legacy snapshot is not evidence for this operation');
      app.store.database.prepare('UPDATE idempotency SET body=? WHERE key=?').run(JSON.stringify({ ...operation.legacy, content: 'Altered historical source' }), operation.row.key);
      assert.equal((await app.request(operation.path, operation.method, operation.input, 'other', operation.key)).status, 409, 'saved source must equal the immutable version');
      app.store.database.prepare('UPDATE idempotency SET body=? WHERE key=?').run(JSON.stringify(operation.legacy), operation.row.key);
      const changedInput = operation.key === 'legacy-restore' ? { ...operation.input, version: 2 } : { ...operation.input, content: 'Different requested source' };
      app.store.database.prepare('UPDATE idempotency SET fingerprint=? WHERE key=?').run(createHash('sha256').update(JSON.stringify([operation.method, operation.path, changedInput])).digest('hex'), operation.row.key);
      assert.equal((await app.request(operation.path, operation.method, changedInput, 'other', operation.key)).status, 409, 'the legacy result remains bound to requested text or restore target');
      app.store.database.prepare('UPDATE idempotency SET fingerprint=? WHERE key=?').run(operation.row.fingerprint, operation.row.key);
    }
    assert.deepEqual(app.versionRows(page.id), rowsAfterPublication); assert.equal((await app.detail(page.id)).document.content, 'Current source after migration');
  } finally { await app.close(); }
});

test('wiki moves copy published content and retain source drafts; inactive pages cannot be deleted', async () => {
  const app = await start();
  try {
    await app.document('/'); const source = await app.document('moving/', 'Published title to move', 'Published source to move');
    await app.operation(source.id, 'drafts', { title: 'Unpublished source title', content: 'Draft source stays here' }); const draft = app.store.documentVersion(source.id, 2);
    const preview = await app.request<WikiMovePreview>(`/api/documents/${source.id}/move-preview?path=destination/`); assert.equal(preview.status, 200);
    const moved = await app.request<WikiMoveReceipt>(`/api/documents/${source.id}/move`, 'POST', preview.body.defaultInput, 'alice', 'move-published'); assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(moved.body.destination.content, source.content); assert.equal(moved.body.destination.title, source.title); assert.equal(moved.body.source.version, 3); assert.equal(moved.body.source.location?.status, 'moved'); assert.deepEqual(app.store.documentVersion(source.id, 2), draft);
    assert.equal((await app.request(`/api/documents/${source.id}/delete`, 'POST', await app.pins(source.id), 'alice', 'delete-moved')).status, 409);
    const selected = await app.operation(source.id, 'publish', { targetVersionId: draft.id }); assert.equal(selected.receipt.document.location?.status, 'moved'); assert.equal(selected.receipt.document.content, draft.content);
    assert.equal((await app.detail(moved.body.destination.id)).document.content, source.content, 'publishing a retained source draft does not mutate the destination');
  } finally { await app.close(); }
});

test('wiki empty authored snapshots are rejected while nonempty whitespace remains exact and deletion is explicit', async () => {
  const app = await start();
  try {
    await app.document('/'); const page = await app.document('whitespace/');
    assert.equal((await app.request('/api/documents', 'POST', { title: 'Empty', slug: 'empty/', content: '' }, 'alice', 'empty-create')).status, 400);
    const pins = await app.pins(page.id);
    assert.equal((await app.request(`/api/documents/${page.id}/drafts`, 'POST', { ...pins, title: 'Empty draft', content: '' }, 'alice', 'empty-draft')).status, 400);
    assert.equal((await app.request(`/api/documents/${page.id}`, 'PUT', { ...pins, title: 'Empty edit', slug: page.slug, content: '' }, 'alice', 'empty-edit')).status, 400);
    const saved = await app.operation(page.id, 'drafts', { title: 'Whitespace', content: ' \t\r\n' }); assert.equal(app.store.documentVersion(page.id, saved.receipt.document.version).content, ' \t\r\n');
    assert.equal(saved.receipt.document.location?.status, 'active'); assert.equal(saved.receipt.document.content, page.content);
  } finally { await app.close(); }
});

test('wiki draft title changes reactivate inactive status while explicit and automatic drafts preserve the published pointer', async () => {
  const app = await start();
  try {
    await app.document('/');
    for (const status of ['deleted', 'moved'] as const) for (const mode of ['explicit', 'automatic'] as const) {
      const page = await app.document(`${status}-${mode}/`, 'Original published title', 'Original published content');
      if (status === 'deleted') await app.operation(page.id, 'delete');
      else {
        const preview = await app.request<WikiMovePreview>(`/api/documents/${page.id}/move-preview?path=destination-${mode}/`); assert.equal(preview.status, 200);
        const moved = await app.request(`/api/documents/${page.id}/move`, 'POST', preview.body.defaultInput, 'alice', `title-move-${mode}`); assert.equal(moved.status, 200);
      }
      const marker = (await app.detail(page.id)).document.publication!.publishedVersionId;
      const unchangedTitle = await app.operation(page.id, 'drafts', { title: page.title, content: 'Unpublished replacement body' });
      assert.equal(unchangedTitle.receipt.document.location?.status, status); assert.equal(unchangedTitle.receipt.document.publication?.publishedVersionId, marker);
      const headBefore = unchangedTitle.receipt.document.version;
      const change = { ...await app.pins(page.id), title: 'Changed draft title', content: 'Unpublished replacement body', message: 'Retitle the draft without changing its body' };
      if (mode === 'explicit') assert.equal((await app.request(`/api/documents/${page.id}/drafts`, 'POST', change, 'alice', `retitle-${status}-${mode}`)).status, 200);
      else assert.equal((await app.request(`/api/documents/${page.id}`, 'PUT', { ...change, slug: page.slug }, 'alice', `retitle-${status}-${mode}`)).status, 200);
      const current = await app.detail(page.id);
      assert.equal(current.document.location?.status, 'active'); assert.equal(current.document.location?.movedToId, null);
      assert.equal(current.document.publication?.publishedVersionId, marker, 'removing an unchanged body transaction must never accidentally publish a draft');
      assert.equal(current.document.content, ''); assert.equal(current.document.title, page.title); assert.equal(current.document.version, headBefore + 1); assert.equal(current.head?.title, change.title); assert.equal(current.head?.content, change.content);
      const repeated = await app.operation(page.id, 'drafts', { title: change.title, content: change.content });
      assert.equal(repeated.receipt.document.version, current.document.version + 1, 'an explicit authored save keeps a new immutable record even when its source is identical');
      assert.equal(repeated.receipt.document.publication?.publishedVersionId, marker);
    }
  } finally { await app.close(); }
});
