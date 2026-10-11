import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp } from './app.ts';
import { createAuth } from './auth.ts';
import { Store } from './store.ts';
import { registerDefaultPolicy } from './policy.ts';
import type { FileRecord } from '../shared/files.ts';
import type { AppState, WikiDetail, WikiDocument, WikiVersion } from '../shared/types.ts';
import type { WikiMoveInput, WikiMovePreview, WikiMoveReceipt, WikiPathResult } from '../shared/wiki.ts';

const workspace = { kind: 'workspace' as const };
const members = (...principalIds: string[]) => ({ kind: 'principals' as const, principalIds });
type Failure = { error: string; code?: string };

async function start() {
  const store = new Store({ path: ':memory:' });
  const provision = createAuth({ database: store.database, mode: 'local', basePath: '/', provisioning: true });
  const alice = await provision.createAccount({ username: 'alice', displayName: 'Alice', password: 'Alice wiki policy test password' });
  const bob = await provision.createAccount({ username: 'bob', displayName: 'Bob', password: 'Bob wiki policy test password' });
  const app = createApp({ store, seed: false, authMode: 'password' });
  const tokens = {
    alice: app.auth.createToken(alice.id, { name: 'Alice', scopes: ['read', 'write'] }),
    aliceOther: app.auth.createToken(alice.id, { name: 'Alice retry', scopes: ['read', 'write'] }),
    bob: app.auth.createToken(bob.id, { name: 'Bob', scopes: ['read', 'write'] }),
    reader: app.auth.createToken(alice.id, { name: 'Read only', scopes: ['read'] }),
  };
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  async function raw(path: string, method = 'GET', input?: unknown, actor: keyof typeof tokens | null = 'alice', key?: string) {
    return fetch(origin + path, {
      method, signal: AbortSignal.timeout(15_000),
      headers: { ...(actor ? { Authorization: `Bearer ${tokens[actor].token}` } : {}), ...(input === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}) },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
  }
  async function request<T = Failure>(path: string, method = 'GET', input?: unknown, actor: keyof typeof tokens | null = 'alice', key?: string) {
    const response = await raw(path, method, input, actor, key);
    return { status: response.status, body: await response.json() as T };
  }
  function policy(id: string, patch: Record<string, unknown>) {
    const current = app.policies.policy(id, alice.id);
    return app.policies.setPolicy(id, { expectedVersion: current.version, spaceId: current.spaceId, ...current.rules, ...patch }, alice.id);
  }
  let sequence = 0;
  async function document(slug: string, patch: Record<string, unknown> = {}, actor: keyof typeof tokens = 'alice') {
    const response = await request<WikiDocument>('/api/documents', 'POST', { title: `Page ${slug}`, slug, content: `Content at ${slug}`, ...patch }, actor, `wiki-create-${++sequence}`);
    assert.equal(response.status, 201, JSON.stringify(response.body)); return response.body;
  }
  async function preview(sourceId: string, destinationPath: string, actor: keyof typeof tokens = 'alice') {
    const response = await request<WikiMovePreview>(`/api/documents/${sourceId}/move-preview?${new URLSearchParams({ path: destinationPath })}`, 'GET', undefined, actor);
    assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body;
  }
  async function move(sourceId: string, destinationPath: string, key = `wiki-move-${++sequence}`) {
    const inspected = await preview(sourceId, destinationPath);
    const response = await request<WikiMoveReceipt>(`/api/documents/${sourceId}/move`, 'POST', inspected.defaultInput, 'alice', key);
    assert.equal(response.status, 200, JSON.stringify(response.body)); return { receipt: response.body, input: inspected.defaultInput, key, inspected };
  }
  async function upload() {
    const bytes = Buffer.from('A wiki attachment with a private uploader policy.');
    const response = await request<FileRecord>('/api/files', 'POST', { name: 'wiki-evidence.txt', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), dataBase64: bytes.toString('base64') }, 'alice', `wiki-file-${++sequence}`);
    assert.equal(response.status, 201, JSON.stringify(response.body)); return response.body;
  }
  let closing: Promise<void> | undefined;
  return { ...app, alice, bob, tokens, raw, request, policy, document, preview, move, upload, close: () => closing ??= (async () => { await app.close(); store.close(); })() };
}

test('wiki ancestor view intersects every read and File grant, while ordinary child edits need no parent edit', async () => {
  const app = await start();
  try {
    const root = await app.document('/'), parent = await app.document('research/'), child = await app.document('research/findings/', { title: 'Sensitive child title', content: 'Sensitive child body' });
    app.policy(parent.id, { edit: members(app.alice.id) });
    const edit = { title: child.title, slug: child.slug, content: 'Bob edited this visible child.', expectedVersion: child.version };
    assert.equal((await app.request(`/api/documents/${child.id}`, 'PUT', edit, 'bob', 'bob-child-edit')).status, 200);
    assert.equal((await app.request('/api/documents', 'POST', { title: 'Denied sibling', slug: 'research/sibling/', content: '' }, 'bob', 'bob-child-create')).status, 403);
    const file = await app.upload();
    const attached = await app.request(`/api/files/${file.id}/attachments`, 'POST', { objectId: child.id, mode: 'attach', expectedVersion: 0, expectedAccessEpoch: app.policies.epoch() }, 'alice', 'wiki-attachment');
    assert.equal(attached.status, 200); assert.equal((await app.request(`/api/files/${file.id}`, 'GET', undefined, 'bob')).status, 200);
    const bytes = await app.raw(`/api/files/${file.id}/data`, 'GET', undefined, 'bob'); assert.equal(bytes.status, 200); await bytes.arrayBuffer();
    for (const ancestor of [parent, root]) {
      app.policy(ancestor.id, { view: members(app.alice.id) });
      for (const path of [`/api/documents/${child.id}`, `/api/documents/${child.id}/history`, `/api/documents/${child.id}/versions/1`, `/api/files/${file.id}`, `/api/files/${file.id}/data`]) {
        assert.equal((await app.request(path, 'GET', undefined, 'bob')).status, 404, path);
      }
      assert.equal((await app.request(`/api/documents/${child.id}`, 'PUT', edit, 'bob', 'bob-child-edit')).status, 404, 'saved writes recheck current ancestor view');
      const state = (await app.request<AppState>('/api/state', 'GET', undefined, 'bob')).body;
      assert.equal(state.documents.some(item => item.id === child.id), false);
      assert.equal(state.activity.some(item => item.objectId === child.id), false);
      assert.equal(state.files?.some(item => item.id === file.id), false);
      assert.equal(JSON.stringify(state).includes('Sensitive child'), false);
      app.policy(ancestor.id, { view: workspace });
      assert.equal((await app.request(`/api/documents/${child.id}`, 'GET', undefined, 'bob')).status, 200);
    }
  } finally { await app.close(); }
});

test('wiki move retains old ancestors and descendants, including moved and deleted ancestor restrictions', async () => {
  const app = await start();
  try {
    await app.document('/'); const parent = await app.document('old/'), child = await app.document('old/child/');
    await app.document('new/');
    const { receipt } = await app.move(parent.id, 'new/parent/');
    assert.equal(receipt.source.id, parent.id); assert.equal(receipt.source.location?.status, 'moved');
    assert.equal(app.store.documentDetail(child.id).document.slug, child.slug, 'moving content never reparents descendants');
    assert.equal((await app.request(`/api/documents/${child.id}`, 'GET', undefined, 'bob')).status, 200);
    app.policy(parent.id, { view: members(app.alice.id) });
    assert.equal((await app.request(`/api/documents/${child.id}`, 'GET', undefined, 'bob')).status, 404);
    assert.equal((await app.request(`/api/documents/${receipt.destination.id}`, 'GET', undefined, 'bob')).status, 200, 'destination has its own ancestry');
    app.policy(parent.id, { view: workspace });
    // Deleted legacy ancestors remain policy objects, even though they contain no live page.
    app.store.database.prepare("UPDATE wiki_locations SET status = 'deleted', moved_to_id = NULL WHERE document_id = ?").run(parent.id);
    app.policy(parent.id, { view: members(app.alice.id) });
    assert.equal((await app.request(`/api/documents/${child.id}/versions/1`, 'GET', undefined, 'bob')).status, 404);
    assert.equal((await app.request(`/api/documents/${parent.id}/move-preview?path=elsewhere/`)).status, 409, 'inactive source cannot move again');
  } finally { await app.close(); }
});

test('wiki creation inherits immediate parent access and moves copy source rules while retaining destination Spaces', async () => {
  const app = await start();
  try {
    await app.document('/'); const sourceParent = await app.document('source/'), destinationParent = await app.document('destination/'), parking = await app.document('parking/');
    const sourceSpace = app.policies.createSpace({ name: 'Source Space', view: workspace, edit: members(app.alice.id) }, app.alice.id);
    const targetSpace = app.policies.createSpace({ name: 'Destination Space', view: workspace, edit: members(app.alice.id) }, app.alice.id);
    const reusedSpace = app.policies.createSpace({ name: 'Existing target Space', view: workspace, edit: members(app.alice.id) }, app.alice.id);
    app.policy(sourceParent.id, { spaceId: sourceSpace.id, view: members(app.alice.id, app.bob.id), edit: members(app.alice.id), interact: members(app.bob.id) });
    app.policy(destinationParent.id, { spaceId: targetSpace.id });
    const first = await app.document('source/first/'); const sourcePolicy = app.policies.policy(first.id, app.alice.id);
    assert.equal(sourcePolicy.spaceId, sourceSpace.id); assert.deepEqual(sourcePolicy.rules, app.policies.policy(sourceParent.id, app.alice.id).rules);
    const fresh = await app.move(first.id, 'destination/fresh/');
    const freshPolicy = app.policies.policy(fresh.receipt.destination.id, app.alice.id);
    assert.equal(fresh.inspected.destinationSpaceId, targetSpace.id); assert.equal(freshPolicy.spaceId, targetSpace.id); assert.deepEqual(freshPolicy.rules, sourcePolicy.rules);
    const existing = await app.document('destination/reused/'); app.policy(existing.id, { spaceId: reusedSpace.id });
    await app.move(existing.id, `${parking.slug}old-target/`);
    const second = await app.document('source/second/');
    const reused = await app.move(second.id, 'destination/reused/'); const reusedPolicy = app.policies.policy(existing.id, app.alice.id);
    assert.equal(reused.receipt.destination.id, existing.id); assert.equal(reused.inspected.destinationSpaceId, reusedSpace.id);
    assert.equal(reusedPolicy.spaceId, reusedSpace.id); assert.deepEqual(reusedPolicy.rules, app.policies.policy(second.id, app.alice.id).rules);
    assert.equal(app.store.documentVersion(existing.id, 1).content, existing.content, 'reusing a destination does not replace its old history');
  } finally { await app.close(); }
});

test('wiki moved links and historical move metadata disclose neither hidden peer identity nor path', async () => {
  const app = await start();
  try {
    await app.document('/'); const source = await app.document('public-source/'); const privateParent = await app.document('private-vault/');
    const space = app.policies.createSpace({ name: 'Private destination', view: workspace, edit: members(app.alice.id) }, app.alice.id);
    app.policy(privateParent.id, { spaceId: space.id });
    const moved = await app.move(source.id, 'private-vault/undisclosed-target/'); const target = moved.receipt.destination;
    const stored = app.store.documentVersion(source.id, moved.receipt.source.version);
    assert.equal(stored.move?.destinationId, target.id); assert.equal(stored.location?.movedToId, target.id);
    const visibleHistory = await app.request<{ accessEpoch: number }>(`/api/documents/${source.id}/history`, 'GET', undefined, 'bob');
    assert.equal(visibleHistory.status, 200); assert.ok(JSON.stringify(visibleHistory.body).includes(target.id));
    app.policies.updateSpace(space.id, { expectedVersion: space.version, view: members(app.alice.id) }, app.alice.id);
    assert.ok(app.policies.epoch() > visibleHistory.body.accessEpoch);
    for (const path of [`/api/documents/${source.id}`, `/api/documents/${source.id}/history`, `/api/documents/${source.id}/versions/${stored.number}`, '/api/state', '/api/wiki?path=public-source/']) {
      const result = await app.request<{ accessEpoch?: number }>(path, 'GET', undefined, 'bob'); assert.equal(result.status, 200, path);
      assert.equal(result.body.accessEpoch, app.policies.epoch(), 'all hierarchy-bearing reads report their current authorization epoch');
      const body = JSON.stringify(result.body); assert.equal(body.includes(target.id), false, path); assert.equal(body.includes('undisclosed-target'), false, path); assert.equal(body.includes('inputSha256'), false, path);
    }
    const detail = (await app.request<WikiDetail>(`/api/documents/${source.id}`, 'GET', undefined, 'bob')).body;
    assert.equal(detail.document.location?.movedToId, null); assert.equal(detail.hierarchy?.movedTo, null);
    assert.equal(detail.history.versions.some(version => version.move !== undefined), false);
    const version = (await app.request<WikiVersion>(`/api/documents/${source.id}/versions/${stored.number}`, 'GET', undefined, 'bob')).body;
    assert.equal(version.move, undefined); assert.equal(version.location?.movedToId, null);
    assert.deepEqual(app.store.documentVersion(source.id, stored.number), stored, 'redaction never rewrites immutable move evidence');
    // The inverse record must also hide its peer if the source later becomes private.
    app.policy(privateParent.id, { spaceId: 'S1' }); app.policy(target.id, { spaceId: 'S1' });
    app.policy(source.id, { view: members(app.alice.id) });
    const destinationVersion = (await app.request<WikiVersion>(`/api/documents/${target.id}/versions/${target.version}`, 'GET', undefined, 'bob')).body;
    assert.equal(destinationVersion.move, undefined);
    assert.equal(JSON.stringify(destinationVersion).includes(source.id), false);
  } finally { await app.close(); }
});

test('wiki creation and a new move destination work in an inherited Space when the default Space is hidden', async () => {
  const app = await start();
  try {
    const space = app.policies.createSpace({ name: 'Wiki Space', view: workspace, edit: members(app.alice.id) }, app.alice.id);
    await app.document('/', { access: { spaceId: space.id } });
    const shared = app.policies.getSpace('S1', app.alice.id);
    app.policies.updateSpace('S1', { expectedVersion: shared.version, view: members(app.alice.id) }, app.alice.id);
    assert.equal(app.policies.access('S1', app.bob.id).view, false);
    const source = await app.document('source/', {}, 'bob');
    assert.equal(app.policies.policy(source.id, app.bob.id).spaceId, space.id);
    const preview = await app.preview(source.id, 'destination/', 'bob');
    assert.equal(preview.destinationSpaceId, space.id);
    const result = await app.request<WikiMoveReceipt>(`/api/documents/${source.id}/move`, 'POST', preview.defaultInput, 'bob', 'move-outside-default-space');
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(app.policies.policy(result.body.destination.id, app.bob.id).spaceId, space.id);
    assert.equal(result.body.destination.content, source.content);
    assert.equal((await app.request(`/api/documents/${result.body.destination.id}`, 'GET', undefined, 'bob')).status, 200);
  } finally { await app.close(); }
});

test('wiki child cursors conceal storage positions, bind their parent, reject tampering, and recheck visibility', async () => {
  const app = await start();
  try {
    await app.document('/'); const parent = await app.document('catalog/'); await app.document('other/');
    const first = await app.document('catalog/first/'), hidden = await app.document('catalog/undisclosed-child/'), revoked = await app.document('catalog/revoked-child/'), last = await app.document('catalog/last/');
    app.policy(hidden.id, { view: members(app.alice.id) });
    const page = await app.request<WikiPathResult>('/api/wiki?path=catalog/&limit=1', 'GET', undefined, 'bob');
    assert.equal(page.status, 200); assert.deepEqual(page.body.hierarchy.children.documents.map(item => item.id), [first.id]);
    const cursor = page.body.hierarchy.children.nextAfter; assert.ok(cursor); assert.match(cursor, /^[A-Za-z0-9_-]+$/); assert.equal(/^\d+$/.test(cursor), false);
    assert.deepEqual(Object.keys(page.body.hierarchy.children).sort(), ['documents', 'missingPaths', 'nextAfter'], 'no hidden totals or storage positions are returned');
    assert.equal(JSON.stringify(page.body).includes('undisclosed-child'), false);
    const route = (path: string, after: string) => `/api/wiki?${new URLSearchParams({ path, after, limit: '1' })}`;
    for (const invalid of ['1', 'not-a-cursor', `${cursor}=`, `${cursor[0] === 'A' ? 'B' : 'A'}${cursor.slice(1)}`]) {
      const result = await app.request(route('catalog/', invalid), 'GET', undefined, 'bob'); assert.equal(result.status, 400);
      assert.equal(JSON.stringify(result.body).includes('undisclosed-child'), false);
    }
    assert.equal((await app.request(route('other/', cursor), 'GET', undefined, 'bob')).status, 400, 'a valid cursor cannot be transplanted to another parent');
    app.policy(revoked.id, { view: members(app.alice.id) });
    const next = await app.request<WikiPathResult>(route('catalog/', cursor), 'GET', undefined, 'bob');
    assert.equal(next.status, 200); assert.deepEqual(next.body.hierarchy.children.documents.map(item => item.id), [last.id]); assert.equal(next.body.hierarchy.children.nextAfter, null);
    assert.equal(next.body.accessEpoch, app.policies.epoch()); assert.equal(JSON.stringify(next.body).includes('revoked-child'), false);
    app.policy(parent.id, { view: members(app.alice.id) });
    const denied = await app.request(route('catalog/', cursor), 'GET', undefined, 'bob'); assert.equal(denied.status, 404);
    assert.equal(JSON.stringify(denied.body).includes(last.title), false);
  } finally { await app.close(); }
});

test('wiki move receipts retain exact committed versions and revalidate credentials and both current authorities', async () => {
  const app = await start();
  try {
    const root = await app.document('/'), source = await app.document('before/');
    const moved = await app.move(source.id, 'after/', 'stable-move'), route = `/api/documents/${source.id}/move`;
    const retry = await app.request<WikiMoveReceipt>(route, 'POST', moved.input, 'aliceOther', moved.key);
    assert.equal(retry.status, 200); assert.deepEqual(retry.body.source, moved.receipt.source); assert.deepEqual(retry.body.destination, moved.receipt.destination);
    const destination = moved.receipt.destination;
    assert.equal((await app.request(`/api/documents/${destination.id}`, 'PUT', { title: 'Later title', slug: destination.slug, content: 'Later content', expectedVersion: destination.version }, 'alice', 'later-destination')).status, 200);
    const historical = await app.request<WikiMoveReceipt>(route, 'POST', moved.input, 'aliceOther', moved.key);
    assert.equal(historical.status, 200); assert.equal(historical.body.destination.version, destination.version); assert.equal(historical.body.destination.content, destination.content);
    assert.equal((await app.request(route, 'POST', moved.input, 'reader', moved.key)).status, 403);
    assert.equal((await app.request(route, 'POST', moved.input, null, moved.key)).status, 401);
    app.policy(root.id, { view: members(app.alice.id), edit: members(app.alice.id) });
    assert.equal((await app.request(route, 'POST', moved.input, 'bob', moved.key)).status, 404);
    app.policy(root.id, { view: workspace, edit: workspace });
    const boundary = app.policies.createSpace({ name: 'Current destination authority', view: workspace, edit: members(app.alice.id, app.bob.id) }, app.alice.id);
    app.policy(destination.id, { spaceId: boundary.id });
    app.policies.updateSpace(boundary.id, { expectedVersion: boundary.version, view: members(app.bob.id), edit: members(app.bob.id) }, app.bob.id);
    assert.equal((await app.request(route, 'POST', moved.input, 'aliceOther', moved.key)).status, 404, 'saved move cannot disclose a destination after its Space revokes this principal');
    app.auth.revokeToken(app.alice.id, app.tokens.aliceOther.record.id);
    assert.equal((await app.request(route, 'POST', moved.input, 'aliceOther', moved.key)).status, 401);
  } finally { await app.close(); }
});

test('legacy wiki gaps remain readable and editable, but fresh creation and movement require every ancestor', async () => {
  const app = await start();
  try {
    await app.document('/');
    // This is a preserved pre-hierarchy row plus its migration sidecar. New
    // writes must never manufacture missing ancestors to make this fixture.
    const legacy: WikiDocument = { id: 'W900', title: 'Legacy orphan', slug: 'gap/middle/leaf', content: 'Preserved legacy content', version: 7, createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-07T00:00:00.000Z' };
    const version: WikiVersion = { id: 'legacy-wiki-version', documentId: legacy.id, number: legacy.version, title: legacy.title, slug: legacy.slug, content: legacy.content, author: null, createdAt: legacy.updatedAt, message: 'Preserved legacy snapshot', kind: 'legacy', restoredFrom: null };
    app.store.database.prepare("INSERT INTO entities(id,kind,data) VALUES(?,'document',?)").run(legacy.id, JSON.stringify(legacy));
    app.store.database.prepare('INSERT INTO wiki_versions(id,document_id,number,data) VALUES(?,?,?,?)').run(version.id, legacy.id, version.number, JSON.stringify(version));
    app.store.database.prepare("INSERT INTO wiki_locations(document_id,path,status,moved_to_id) VALUES(?,?,'active',NULL)").run(legacy.id, 'gap/middle/leaf/');
    registerDefaultPolicy(app.store.database, legacy.id);
    assert.equal((await app.request(`/api/documents/${legacy.id}`, 'GET', undefined, 'bob')).status, 200);
    const found = await app.request<WikiPathResult>('/api/wiki?path=gap/middle/leaf/', 'GET', undefined, 'bob');
    assert.equal(found.status, 200); assert.equal(found.body.document?.id, legacy.id);
    assert.deepEqual(found.body.hierarchy.ancestors.filter(item => !item.document).map(item => item.path), ['gap/', 'gap/middle/']);
    const missing = await app.request<WikiPathResult>('/api/wiki?path=gap/new/', 'GET', undefined, 'bob');
    assert.equal(missing.status, 200); assert.equal(missing.body.document, null); assert.equal(missing.body.canCreate, false);
    assert.equal((await app.request('/api/documents', 'POST', { title: 'New child', slug: 'gap/new/', content: '' }, 'bob', 'missing-parent-create')).status, 409);
    assert.equal((await app.request(`/api/documents/${legacy.id}/move-preview?path=other/missing/`)).status, 409);
    const edited = await app.request<WikiDocument>(`/api/documents/${legacy.id}`, 'PUT', { title: legacy.title, slug: legacy.slug, content: 'A same-path legacy edit', expectedVersion: legacy.version }, 'bob', 'legacy-edit');
    assert.equal(edited.status, 200); assert.equal(edited.body.version, 8);
    assert.equal(app.store.documentVersion(legacy.id, 7).content, legacy.content);
    const ancestor = await app.document('gap/');
    app.policy(ancestor.id, { view: members(app.alice.id) });
    assert.equal((await app.request(`/api/documents/${legacy.id}/history`, 'GET', undefined, 'bob')).status, 404, 'a newly existing ancestor immediately restricts old orphan history');
  } finally { await app.close(); }
});

test('wiki deep ancestry remains readable and existing inactive destinations still require parent edit', async () => {
  const app = await start();
  try {
    await app.document('/'); let leaf!: WikiDocument;
    for (let depth = 1; depth <= 24; depth++) leaf = await app.document('a/'.repeat(depth));
    assert.equal((await app.request(`/api/documents/${leaf.id}`, 'GET', undefined, 'bob')).status, 200, 'wiki ancestry is not limited by the unrelated dependency recursion limit');
    const parent = await app.document('reuse/'), existing = await app.document('reuse/existing/');
    await app.move(existing.id, 'parked/');
    const source = await app.document('source/'); app.policy(parent.id, { edit: members(app.alice.id) });
    assert.equal((await app.request(`/api/documents/${source.id}/move-preview?path=reuse/existing/`, 'GET', undefined, 'bob')).status, 403);
    const original = app.store.documentDetail(source.id).document;
    const preview = await app.preview(source.id, 'reuse/existing/');
    const statuses = await Promise.all([
      app.request(`/api/documents/${source.id}/move`, 'POST', preview.defaultInput, 'alice', 'race-first'),
      app.request(`/api/documents/${source.id}/move`, 'POST', preview.defaultInput, 'alice', 'race-second'),
    ]);
    assert.deepEqual(statuses.map(result => result.status).sort(), [200, 409]);
    assert.equal(app.store.documentDetail(source.id).document.version, original.version + 1);
  } finally { await app.close(); }
});

test('wiki move requires destination parent edit, pins the reviewed audience, and rejects substituted canonical receipts', async () => {
  const app = await start();
  try {
    await app.document('/'); const source = await app.document('from/'), parent = await app.document('target/');
    const longPath = `${'a'.repeat(128)}/`;
    const readable = await app.request<WikiPathResult>(`/api/wiki?${new URLSearchParams({ path: longPath })}`);
    assert.equal(readable.status, 200); assert.equal(readable.body.canCreate, false, 'legacy read bounds do not authorize a new oversized path');
    assert.equal((await app.request(`/api/documents/${source.id}/move-preview?${new URLSearchParams({ path: longPath })}`)).status, 400);
    app.policy(parent.id, { edit: members(app.alice.id) });
    assert.equal((await app.request(`/api/documents/${source.id}/move-preview?path=target/new/`, 'GET', undefined, 'bob')).status, 403);
    const inspected = await app.preview(source.id, 'target/new/');
    app.policy(parent.id, { interact: members(app.alice.id) });
    const route = `/api/documents/${source.id}/move`;
    assert.equal((await app.request(route, 'POST', inspected.defaultInput, 'alice', 'stale-audience')).status, 409);
    assert.equal(app.store.documentDetail(source.id).document.version, source.version);
    const moved = await app.move(source.id, 'target/new/', 'canonical-move');
    const different: WikiMoveInput = { ...moved.input, destinationPath: 'target/different/' };
    const fingerprint = createHash('sha256').update(JSON.stringify(['POST', route, different])).digest('hex');
    app.store.database.prepare("UPDATE idempotency SET fingerprint=? WHERE key LIKE '%:canonical-move'").run(fingerprint);
    const replay = await app.request(route, 'POST', different, 'aliceOther', 'canonical-move');
    assert.equal(replay.status, 409, 'a genuine receipt for another destination is not evidence of this requested move');
    assert.equal(app.store.documentDetail(source.id).document.version, moved.receipt.source.version);
  } finally { await app.close(); }
});
