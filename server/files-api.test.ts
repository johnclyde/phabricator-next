import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp, type AppOptions } from './app.ts';
import { createAuth } from './auth.ts';
import { Store, contentHash } from './store.ts';
import type { PaperRunner } from './paper-builds.ts';
import type { FileAttachment, FileAttachmentPage, FileDetail, FileHistory, FilePage, FileRecord, RevisionAsset } from '../shared/files.ts';
import type { PaperBuild, PaperBuildDetail } from '../shared/paper-builds.ts';
import type { RevisionDetail, RevisionVersion } from '../shared/types.ts';

const workspace = { kind: 'workspace' as const };
const members = (...principalIds: string[]) => ({ kind: 'principals' as const, principalIds });
const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const source = [{ path: 'main.tex', content: 'Original paper.\nSecond sentence.\n' }];
const uploadInput = (name = 'figure.png', bytes = png) => ({ name, dataBase64: bytes.toString('base64'), sha256: digest(bytes), bytes: bytes.length });
function asset(file: FileRecord, path = 'figures/plot.png'): RevisionAsset {
  assert.notEqual(file.mediaType, 'application/octet-stream');
  return { path, fileId: file.id, sha256: file.sha256, bytes: file.bytes, mediaType: file.mediaType as RevisionAsset['mediaType'] };
}
const version = (detail: RevisionDetail) => detail.versions.find(item => item.number === detail.revision.currentVersion)!;
const pins = (value: RevisionVersion) => ({ expectedVersion: value.number, expectedVersionId: value.id, expectedContentHash: value.contentHash });
type ErrorBody = { error: string; code?: string };

async function start(options: AppOptions = {}) {
  const store = new Store({ path: ':memory:' });
  const provision = createAuth({ database: store.database, mode: 'local', basePath: '/', provisioning: true });
  const alice = await provision.createAccount({ username: 'alice', displayName: 'Alice', password: 'Alice immutable figures password' });
  const bob = await provision.createAccount({ username: 'bob', displayName: 'Bob', password: 'Bob immutable figures password' });
  const app = createApp({ ...options, store, seed: false, authMode: 'password' });
  const tokens = {
    alice: app.auth.createToken(alice.id, { name: 'Alice', scopes: ['read', 'write'] }),
    aliceOther: app.auth.createToken(alice.id, { name: 'Another Alice credential', scopes: ['read', 'write'] }),
    bob: app.auth.createToken(bob.id, { name: 'Bob', scopes: ['read', 'write'] }),
    reader: app.auth.createToken(alice.id, { name: 'Reader', scopes: ['read'] }),
  };
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  async function raw(path: string, method = 'GET', body?: unknown, actor: keyof typeof tokens | null = 'alice', key?: string) {
    return fetch(origin + path, { method, signal: AbortSignal.timeout(10_000), headers: { ...(actor ? { Authorization: `Bearer ${tokens[actor].token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  async function request<T = ErrorBody>(path: string, method = 'GET', body?: unknown, actor: keyof typeof tokens | null = 'alice', key?: string) {
    const response = await raw(path, method, body, actor, key);
    return { status: response.status, headers: response.headers, body: await response.json() as T };
  }
  const policy = (id: string, changes: Record<string, unknown>, principal = alice.id) => {
    const current = app.policies.policy(id, principal);
    return app.policies.setPolicy(id, { expectedVersion: current.version, spaceId: current.spaceId, ...current.rules, ...changes }, principal);
  };
  let sequence = 0;
  async function upload(name = 'figure.png', bytes = png, actor: keyof typeof tokens = 'alice') {
    const result = await request<FileRecord>('/api/files', 'POST', uploadInput(name, bytes), actor, `upload-${++sequence}`);
    assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body;
  }
  async function attachment(file: FileRecord, objectId: string, mode: FileAttachment['mode'], actor: keyof typeof tokens = 'alice') {
    const input = { objectId, mode, expectedVersion: store.files.attachment(file.id, objectId)?.version ?? 0, ...(mode === 'attach' ? { expectedAccessEpoch: app.policies.epoch() } : {}) };
    return request<FileAttachment>(`/api/files/${file.id}/attachments`, 'POST', input, actor, `attachment-${++sequence}`);
  }
  async function paper(assets: RevisionAsset[], extra: Record<string, unknown> = {}) {
    const result = await request<RevisionDetail>('/api/revisions', 'POST', { title: 'Paper with immutable figures', kind: 'paper', files: source, assets, shareAssets: true, expectedAccessEpoch: app.policies.epoch(), ...extra }, 'alice', `paper-${++sequence}`);
    assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body;
  }
  const rows = (table: string) => store.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
  const evidence = () => Object.fromEntries(['entities', 'versions', 'file_blobs', 'file_contents', 'file_transactions', 'file_attachments', 'file_upload_receipts', 'object_policies', 'policy_meta', 'idempotency', 'sequences', 'activity'].map(table => [table, rows(table)]));
  return { ...app, alice, bob, tokens, origin, raw, request, policy, upload, attachment, paper, rows, evidence, close: async () => { await app.close(); store.close(); } };
}

test('uploads begin private, exact replay and receipts belong to a principal, and bytes always require current authority', async () => {
  const app = await start();
  try {
    const input = uploadInput("figure's λ.png");
    assert.equal((await app.request('/api/files', 'POST', input, null, 'private')).status, 401);
    assert.equal((await app.request('/api/files', 'POST', input)).status, 400);
    assert.equal((await app.request('/api/files', 'POST', input, 'reader', 'private')).status, 403);
    const [a, b] = await Promise.all([app.request<FileRecord>('/api/files', 'POST', input, 'alice', 'private'), app.request<FileRecord>('/api/files', 'POST', input, 'aliceOther', 'private')]);
    assert.equal(a.status, 201); assert.deepEqual(a.body, b.body); const file = a.body;
    assert.equal(file.authorId, app.alice.id); assert.equal(app.rows('file_contents').length, 1); assert.equal(app.rows('file_upload_receipts').length, 1);
    const detail = await app.request<FileDetail>(`/api/files/${file.id}`);
    assert.equal(detail.body.access?.automatic?.kind, 'file-author'); assert.equal(detail.body.access?.capabilities.edit, true);
    assert.equal((await app.request(`/api/files/${file.id}`, 'GET', undefined, 'bob')).status, 404);
    assert.equal((await app.request<FilePage>('/api/files', 'GET', undefined, 'bob')).body.files.length, 0);
    assert.equal((await app.request('/api/files/uploads/private', 'GET', undefined, 'bob')).status, 404);
    assert.deepEqual((await app.request<FileRecord>('/api/files/uploads/private', 'GET', undefined, 'aliceOther')).body, file);
    assert.equal((await app.request('/api/files/uploads/private?limit=1')).status, 400);
    assert.equal((await app.request('/api/files', 'POST', { ...input, name: 'different.png' }, 'alice', 'private')).status, 409);
    const bobUpload = await app.request<FileRecord>('/api/files', 'POST', input, 'bob', 'private'); assert.equal(bobUpload.status, 201); assert.notEqual(bobUpload.body.id, file.id);
    assert.equal(app.rows('file_blobs').length, 1, 'byte deduplication must not deduplicate ownership');
    assert.equal((await app.request(`/api/files/${file.id}/data`, 'GET', undefined, 'bob')).status, 404);
    const data = await app.raw(`/api/files/${file.id}/data`, 'GET', undefined, 'reader');
    assert.equal(data.status, 200); assert.equal(data.headers.get('content-type'), 'image/png'); assert.equal(data.headers.get('content-length'), String(png.length));
    assert.equal(data.headers.get('cache-control'), 'private, no-store'); assert.equal(data.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(data.headers.get('x-content-sha256'), digest(png)); assert.equal(data.headers.get('x-access-epoch'), String(app.policies.epoch()));
    assert.match(data.headers.get('content-disposition')!, /^attachment; filename="F\d+"; filename\*=UTF-8''figure%27s%20%CE%BB\.png$/);
    assert.deepEqual(Buffer.from(await data.arrayBuffer()), png);
    app.auth.revokeToken(app.alice.id, app.tokens.alice.record.id);
    assert.equal((await app.request('/api/files/uploads/private')).status, 401);
    assert.equal((await app.request('/api/files/uploads/private', 'GET', undefined, 'aliceOther')).status, 200);
    app.auth.setAccountDisabled(app.alice.id, true);
    assert.equal((await app.request(`/api/files/${file.id}/data`, 'GET', undefined, 'aliceOther')).status, 401);
  } finally { await app.close(); }
});

test('upload failures roll back blobs, identities, policies, audit, receipts and replay records together', async () => {
  const app = await start();
  try {
    const before = app.evidence();
    for (const invalid of [{ sha256: '0'.repeat(64) }, { bytes: png.length + 1 }, { mediaType: 'image/png' }, { dataBase64: png.toString('base64') + '\n' }]) {
      assert.equal((await app.request('/api/files', 'POST', { ...uploadInput(), ...invalid }, 'alice', 'retry')).status, 400);
      assert.deepEqual(app.evidence(), before);
    }
    app.store.database.exec("CREATE TRIGGER failed_file_audit BEFORE INSERT ON activity WHEN NEW.object_id GLOB 'F*' BEGIN SELECT RAISE(ABORT, 'test rollback'); END;");
    assert.equal((await app.request('/api/files', 'POST', uploadInput(), 'alice', 'retry')).status, 500); assert.deepEqual(app.evidence(), before);
    app.store.database.exec('DROP TRIGGER failed_file_audit');
    const saved = await app.request<FileRecord>('/api/files', 'POST', uploadInput(), 'alice', 'retry'); assert.equal(saved.status, 201); assert.equal(saved.body.id, 'F1');
    assert.equal((await app.request('/api/files/uploads/retry')).status, 200);
    app.store.database.exec('DROP TRIGGER file_blobs_no_update');
    app.store.database.prepare('UPDATE file_blobs SET data=? WHERE sha256=?').run(Buffer.alloc(png.length), saved.body.sha256);
    const corrupted = await app.request(`/api/files/${saved.body.id}/data`); assert.equal(corrupted.status, 409); assert.equal(corrupted.body.code, 'FILE_INTEGRITY');
  } finally { await app.close(); }
});

test('metadata edits are optimistic and replayable; list and history pages exclude hidden data before applying limits', async () => {
  const app = await start();
  try {
    const first = await app.upload('first.png'); await app.upload('hidden.png', png, 'bob'); const third = await app.upload('third.png');
    const page = await app.request<FilePage>('/api/files?limit=1'); assert.deepEqual(page.body.files.map(file => file.id), [third.id]); assert.ok(page.body.nextBefore);
    const next = await app.request<FilePage>(`/api/files?limit=1&before=${page.body.nextBefore}`); assert.deepEqual(next.body.files.map(file => file.id), [first.id]); assert.equal(next.body.nextBefore, null);
    for (const query of ['?limit=101', '?limit=1&limit=2', '?before=0', '?limit=1.5', '?status=deleted', '?sha256=' + first.sha256]) assert.equal((await app.request('/api/files' + query)).status, 400, query);
    const edit = { expectedVersion: 1, name: 'Renamed figure', altText: 'A precise text equivalent.' };
    const changed = await app.request<FileRecord>(`/api/files/${first.id}`, 'PATCH', edit, 'alice', 'metadata'); assert.equal(changed.status, 200); assert.equal(changed.body.version, 2); assert.equal(changed.body.originalName, first.originalName);
    assert.deepEqual((await app.request<FileRecord>(`/api/files/${first.id}`, 'PATCH', edit, 'aliceOther', 'metadata')).body, changed.body);
    assert.equal((await app.request(`/api/files/${first.id}`, 'PATCH', edit, 'alice', 'stale')).status, 409);
    assert.equal((await app.request(`/api/files/${first.id}`, 'PATCH', { expectedVersion: 2, sha256: '0'.repeat(64) }, 'alice', 'immutable')).status, 400);
    assert.equal((await app.request(`/api/files/${first.id}`, 'PATCH', { expectedVersion: 2, name: 'Read only' }, 'reader', 'scope')).status, 403);
    const archived = await app.request<FileRecord>(`/api/files/${first.id}`, 'PATCH', { expectedVersion: 2, status: 'archived' }, 'alice', 'archive'); assert.equal(archived.status, 200);
    assert.deepEqual((await app.request<FilePage>('/api/files')).body.files.map(file => file.id), [third.id]);
    assert.deepEqual((await app.request<FilePage>('/api/files?status=archived&name=Renamed')).body.files.map(file => file.id), [first.id]);
    const head = await app.request<FileHistory>(`/api/files/${first.id}/history?limit=1`); assert.equal(head.body.transactions[0]?.kind, 'edit'); assert.equal(head.body.transactions[0]?.sequence, 3);
    const middle = await app.request<FileHistory>(`/api/files/${first.id}/history?limit=1&before=${head.body.nextBefore}`); assert.equal(middle.body.transactions[0]?.sequence, 2);
    const tail = await app.request<FileHistory>(`/api/files/${first.id}/history?limit=1&before=${middle.body.nextBefore}`); assert.equal(tail.body.transactions[0]?.kind, 'upload'); assert.equal(tail.body.nextBefore, null); assert.equal(tail.body.transactions[0]?.snapshot?.name, 'first.png');
    const bytes = await app.raw(`/api/files/${first.id}/data`); assert.deepEqual(Buffer.from(await bytes.arrayBuffer()), png, 'archiving does not rewrite or destroy historical bytes');
  } finally { await app.close(); }
});

test('references grant nothing; explicit attachments require both editors and a current audience, and hide unrelated attachment history', async () => {
  const app = await start();
  try {
    const file = await app.upload(); const target = app.store.createTask({ title: 'Public target' }); const secret = app.store.createTask({ title: 'Secret target' });
    app.policy(secret.id, { view: members(app.alice.id), edit: members(app.alice.id), interact: members(app.alice.id) });
    assert.equal((await app.attachment(file, target.id, 'reference')).status, 200);
    assert.equal((await app.request(`/api/files/${file.id}`, 'GET', undefined, 'bob')).status, 404);
    const input = { objectId: target.id, mode: 'attach', expectedVersion: 1, expectedAccessEpoch: app.policies.epoch() };
    assert.equal((await app.request(`/api/files/${file.id}/attachments`, 'POST', input, 'bob', 'not-editor')).status, 404);
    app.policy(target.id, { edit: members(app.bob.id) }, app.bob.id);
    assert.equal((await app.request(`/api/files/${file.id}/attachments`, 'POST', { ...input, expectedAccessEpoch: app.policies.epoch() }, 'alice', 'target-editor')).status, 403);
    app.policy(target.id, { edit: workspace }, app.bob.id);
    const stale = await app.request(`/api/files/${file.id}/attachments`, 'POST', input, 'alice', 'audience'); assert.equal(stale.status, 409); assert.equal(stale.body.code, 'ACCESS_EPOCH_CHANGED');
    const fresh = { ...input, expectedAccessEpoch: app.policies.epoch() };
    assert.equal((await app.request(`/api/files/${file.id}/attachments`, 'POST', fresh, 'alice', 'audience')).status, 200);
    assert.equal((await app.attachment(file, secret.id, 'attach')).status, 200);
    const bob = await app.request<FileDetail>(`/api/files/${file.id}`, 'GET', undefined, 'bob'); assert.equal(bob.status, 200); assert.equal(bob.body.access?.capabilities.edit, false); assert.equal(bob.body.access?.capabilities.interact, false);
    assert.deepEqual(bob.body.attachments.attachments.map(item => item.objectId), [target.id]);
    assert.equal(bob.body.history.transactions.some(item => item.attachment?.objectId === secret.id), false);
    const attachmentPage = await app.request<FileAttachmentPage>(`/api/files/${file.id}/attachments?limit=1`, 'GET', undefined, 'bob'); assert.deepEqual(attachmentPage.body.attachments.map(item => item.objectId), [target.id]); assert.equal(attachmentPage.body.nextBefore, null);
    const exact = await app.request<{ attachment: FileAttachment | null; accessEpoch: number }>(`/api/files/${file.id}/attachments/${target.id}`, 'GET', undefined, 'bob'); assert.equal(exact.status, 200); assert.equal(exact.body.attachment?.mode, 'attach'); assert.equal(exact.body.accessEpoch, app.policies.epoch());
    assert.equal((await app.request(`/api/files/${file.id}/attachments/${secret.id}`, 'GET', undefined, 'bob')).status, 400, 'unavailable attachment targets do not revoke the visible File itself');
    assert.equal((await app.request(`/api/files/${file.id}`, 'PATCH', { expectedVersion: 1, name: 'Cannot edit' }, 'bob', 'no-edit')).status, 403);
    assert.equal((await app.request(`/api/files/${file.id}/attachments`, 'POST', fresh, 'alice', 'audience')).status, 200, 'exact replay survives later epoch changes');
    app.policy(target.id, { edit: members(app.bob.id) }, app.bob.id);
    assert.equal((await app.request(`/api/files/${file.id}/attachments`, 'POST', fresh, 'alice', 'audience')).status, 403, 'replay still checks current target edit');
    app.policy(target.id, { view: members(app.bob.id), edit: members(app.bob.id) }, app.bob.id);
    assert.equal((await app.request(`/api/files/${file.id}/attachments`, 'POST', fresh, 'alice', 'audience')).status, 404);
  } finally { await app.close(); }
});

test('the File Space ceiling overrides automatic author and attachment grants and invalidates saved upload receipts', async () => {
  const app = await start();
  try {
    const result = await app.request<FileRecord>('/api/files', 'POST', uploadInput(), 'alice', 'space-upload'); assert.equal(result.status, 201); const file = result.body;
    const target = app.store.createTask({ title: 'Visible outside the File Space' }); assert.equal((await app.attachment(file, target.id, 'attach')).status, 200);
    const space = app.policies.createSpace({ name: 'File ceiling', view: workspace, edit: members(app.alice.id, app.bob.id) }, app.alice.id);
    app.policy(file.id, { spaceId: space.id, view: members(app.bob.id), edit: members(app.bob.id) });
    assert.equal((await app.request<FileDetail>(`/api/files/${file.id}`)).body.access?.capabilities.edit, true, 'author access survives restrictive object rules');
    app.policies.updateSpace(space.id, { expectedVersion: space.version, view: members(app.bob.id), edit: members(app.bob.id) }, app.bob.id);
    for (const path of [`/api/files/${file.id}`, `/api/files/${file.id}/data`, '/api/files/uploads/space-upload']) assert.equal((await app.request(path)).status, 404, path);
    assert.equal((await app.request('/api/files', 'POST', uploadInput(), 'aliceOther', 'space-upload')).status, 404);
    assert.equal((await app.request<FilePage>('/api/files')).body.files.length, 0);
    const bytes = await app.raw(`/api/files/${file.id}/data`, 'GET', undefined, 'bob'); assert.equal(bytes.status, 200); await bytes.arrayBuffer();
  } finally { await app.close(); }
});

test('version manifests bind exact immutable bytes, preserve legacy hashes and inherited figures, and invalidate accepted evidence', async () => {
  const app = await start();
  try {
    const figure = await app.upload(); const duplicate = await app.upload('same-bytes.png');
    const plain = app.store.createRevision({ title: 'Text history', kind: 'paper', files: source }); const original = version(plain); const rawOriginal = app.rows('versions')[0];
    assert.equal(original.contentHash, digest(JSON.stringify(source))); assert.equal(original.assets, undefined);
    const firstInput = { ...pins(original), files: source, assets: [asset(figure)], shareAssets: true, expectedAccessEpoch: app.policies.epoch(), message: 'Add figure' };
    const added = await app.request<RevisionDetail>(`/api/revisions/${plain.revision.id}/versions`, 'POST', firstInput, 'alice', 'add-figure'); assert.equal(added.status, 201, JSON.stringify(added.body)); let current = version(added.body);
    assert.equal(current.contentHash, contentHash(source, [asset(figure)])); assert.notEqual(current.contentHash, original.contentHash); assert.deepEqual(app.rows('versions')[0], rawOriginal);
    assert.deepEqual((await app.request<RevisionDetail>(`/api/revisions/${plain.revision.id}`, 'GET', undefined, 'bob')).body.versions[1]?.assets, [asset(figure)]);
    app.store.saveReview(plain.revision.id, current.number, { provider: 'local', model: 'deterministic-checks', summary: 'Checked exact version', findings: [] });
    app.store.updateRevision(plain.revision.id, { status: 'accepted', expectedVersion: current.number });
    const replaced = await app.request<RevisionDetail>(`/api/revisions/${plain.revision.id}/versions`, 'POST', { ...pins(current), files: source, assets: [asset(duplicate)], shareAssets: true, expectedAccessEpoch: app.policies.epoch(), message: 'Replace same bytes with a new File identity' });
    assert.equal(replaced.status, 201); assert.equal(replaced.body.revision.status, 'needs_review'); assert.notEqual(version(replaced.body).contentHash, current.contentHash); current = version(replaced.body);
    const inherited = await app.request<RevisionDetail>(`/api/revisions/${plain.revision.id}/versions`, 'POST', { expectedVersion: current.number, files: [{ path: 'main.tex', content: 'Edited text.\n' }], message: 'Legacy text-only save' }, 'bob');
    assert.equal(inherited.status, 201, JSON.stringify(inherited.body)); assert.deepEqual(version(inherited.body).assets, [asset(duplicate)]); current = version(inherited.body);
    const preserved = await app.request<RevisionDetail>(`/api/revisions/${plain.revision.id}/versions`, 'POST', { ...pins(current), files: current.files, assets: current.assets, expectedAccessEpoch: app.policies.epoch(), message: 'A source editor preserves the manifest' }, 'bob');
    assert.equal(preserved.status, 201, JSON.stringify(preserved.body)); current = version(preserved.body);
    const comment = app.store.createComment(plain.revision.id, { body: 'Improve wording', versionId: current.id, filePath: 'main.tex', passage: { start: 0, end: 6, quote: 'Edited' }, suggestion: { replacement: 'Revised' } });
    const applied = await app.request<RevisionDetail>(`/api/revisions/${plain.revision.id}/suggestions/${comment.id}/apply`, 'POST', { ...pins(current), expectedThreadVersion: 1 }, 'bob');
    assert.equal(applied.status, 201, JSON.stringify(applied.body)); current = version(applied.body); assert.deepEqual(current.assets, [asset(duplicate)]); assert.equal(current.files[0]?.content, 'Revised text.\n'); assert.equal(current.contentHash, contentHash(current.files, current.assets));
    const removed = await app.request<RevisionDetail>(`/api/revisions/${plain.revision.id}/versions`, 'POST', { ...pins(current), files: current.files, assets: [], expectedAccessEpoch: app.policies.epoch(), message: 'Remove figure from new version' }, 'bob');
    assert.equal(removed.status, 201); assert.equal(version(removed.body).assets, undefined); assert.equal(version(removed.body).contentHash, contentHash(current.files));
    assert.deepEqual(removed.body.versions[1]?.assets, [asset(figure)]); assert.deepEqual(app.store.files.readBytes(figure.id), new Uint8Array(png));
    assert.equal((await app.request<RevisionDetail>(`/api/revisions/${plain.revision.id}/versions`, 'POST', firstInput, 'alice', 'add-figure')).body.versions.length, 2, 'exact replay returns the original saved evidence');
  } finally { await app.close(); }
});

test('asset writes reject changed pins, identity forgery, path collisions, unseen files and implicit audience expansion atomically', async () => {
  const app = await start();
  try {
    const figure = await app.upload(); const hidden = await app.upload('hidden.png', png, 'bob');
    const plain = app.store.createRevision({ title: 'Text history', kind: 'paper', files: source }); const original = version(plain);
    const input = { ...pins(original), files: source, assets: [asset(figure)], shareAssets: true, expectedAccessEpoch: app.policies.epoch(), message: 'Add figure' };
    const before = app.evidence();
    for (const patch of [
      { expectedVersionId: 'another' }, { expectedContentHash: '0'.repeat(64) }, { expectedVersion: 2 },
      { assets: [{ ...asset(figure), sha256: '0'.repeat(64) }] }, { assets: [{ ...asset(figure), bytes: png.length + 1 }] }, { assets: [{ ...asset(figure), mediaType: 'application/pdf' }] },
      { assets: [asset(figure, 'main.tex')] }, { assets: [asset(figure, 'MAIN.TEX')] }, { assets: [asset(figure, '../figure.png')] }, { assets: [asset(figure, 'main.tex/figure.png')] },
      { shareAssets: false }, { expectedAccessEpoch: input.expectedAccessEpoch - 1 }, { assets: [asset(hidden)] },
    ]) {
      const response = await app.request(`/api/revisions/${plain.revision.id}/versions`, 'POST', { ...input, ...patch }, 'alice', 'invalid');
      assert.ok([400, 404, 409].includes(response.status), JSON.stringify({ patch, response })); assert.deepEqual(app.evidence(), before);
    }
    const withoutPins = { ...input }; delete (withoutPins as Partial<typeof input>).expectedVersionId;
    assert.equal((await app.request(`/api/revisions/${plain.revision.id}/versions`, 'POST', withoutPins)).status, 409); assert.deepEqual(app.evidence(), before);
    const initial = await app.paper([asset(figure)]); const id = initial.revision.id;
    const other = await app.upload('new-figure.png'); assert.equal((await app.attachment(other, id, 'attach')).status, 200);
    const denied = await app.request(`/api/revisions/${id}/versions`, 'POST', { ...pins(version(initial)), files: source, assets: [asset(other)], shareAssets: true, expectedAccessEpoch: app.policies.epoch(), message: 'Already shared but not in this version' }, 'bob');
    assert.equal(denied.status, 403, 'a paper editor cannot introduce a File merely because an existing attachment makes it readable');
    assert.equal((await app.request(`/api/files/${figure.id}`, 'PATCH', { expectedVersion: 1, status: 'archived' }, 'alice', 'archive')).status, 200);
    const rejected = await app.request('/api/revisions', 'POST', { title: 'No archived new attachment', kind: 'paper', files: source, assets: [asset(figure)], shareAssets: true, expectedAccessEpoch: app.policies.epoch() }); assert.equal(rejected.status, 409);
    const retained = await app.request<RevisionDetail>(`/api/revisions/${id}/versions`, 'POST', { ...pins(version(initial)), files: source, assets: [asset(figure)], expectedAccessEpoch: app.policies.epoch(), message: 'Retain archived existing identity' }, 'bob'); assert.equal(retained.status, 201, JSON.stringify(retained.body));
    const bytes = await app.raw(`/api/files/${figure.id}/data`, 'GET', undefined, 'bob'); assert.equal(bytes.status, 200); await bytes.arrayBuffer();
  } finally { await app.close(); }
});

test('only explicit reviewed sharing reattaches an existing figure after detachment', async () => {
  const app = await start();
  try {
    const file = await app.upload(); let detail = await app.paper([asset(file)]); const id = detail.revision.id;
    assert.equal((await app.attachment(file, id, 'detach')).status, 200);
    const edited = await app.request<RevisionDetail>(`/api/revisions/${id}/versions`, 'POST', { expectedVersion: version(detail).number, files: source, message: 'Ordinary source save' }); assert.equal(edited.status, 201); detail = edited.body;
    assert.equal(app.store.files.attachment(file.id, id)?.mode, 'detach'); assert.equal((await app.request(`/api/revisions/${id}`, 'GET', undefined, 'bob')).status, 404);
    const input = { ...pins(version(detail)), files: source, assets: [asset(file)], expectedAccessEpoch: app.policies.epoch(), message: 'Share the existing figure again' };
    assert.equal((await app.request(`/api/revisions/${id}/versions`, 'POST', input)).status, 400, 'a missing consent flag never reattaches');
    const shared = await app.request<RevisionDetail>(`/api/revisions/${id}/versions`, 'POST', { ...input, shareAssets: true }); assert.equal(shared.status, 201, JSON.stringify(shared.body));
    assert.equal(app.store.files.attachment(file.id, id)?.mode, 'attach'); assert.equal((await app.request(`/api/revisions/${id}`, 'GET', undefined, 'bob')).status, 200);
  } finally { await app.close(); }
});

test('all historical figures remain access dependencies; detachment and current alternative grants cannot bypass a File Space', async () => {
  const app = await start();
  try {
    const file = await app.upload(); const initial = await app.paper([asset(file)]); const id = initial.revision.id;
    const removed = await app.request<RevisionDetail>(`/api/revisions/${id}/versions`, 'POST', { ...pins(version(initial)), files: source, assets: [], expectedAccessEpoch: app.policies.epoch(), message: 'Remove the current figure' }); assert.equal(removed.status, 201);
    assert.equal((await app.attachment(file, id, 'detach')).status, 200);
    assert.equal((await app.request(`/api/revisions/${id}`, 'GET', undefined, 'bob')).status, 404, 'historical evidence is not silently exposed after detachment');
    assert.equal((await app.request(`/api/files/${file.id}/data`, 'GET', undefined, 'bob')).status, 404);
    const target = app.store.createTask({ title: 'Independent authorized grant' }); assert.equal((await app.attachment(file, target.id, 'attach')).status, 200);
    assert.equal((await app.request(`/api/revisions/${id}`, 'GET', undefined, 'bob')).status, 200);
    app.policy(target.id, { view: members(app.alice.id), edit: members(app.alice.id) });
    assert.equal((await app.request(`/api/revisions/${id}`, 'GET', undefined, 'bob')).status, 404);
    app.policy(target.id, { view: workspace });
    const space = app.policies.createSpace({ name: 'Figure private Space', view: members(app.alice.id), edit: members(app.alice.id) }, app.alice.id); app.policy(file.id, { spaceId: space.id });
    assert.equal((await app.request(`/api/revisions/${id}`, 'GET', undefined, 'bob')).status, 404);
    assert.equal((await app.request(`/api/files/${file.id}`, 'GET', undefined, 'bob')).status, 404);
    assert.equal((await app.request(`/api/revisions/${id}`)).status, 200);
  } finally { await app.close(); }
});

test('cyclic attachment chains and a shared paper with a hidden second figure never manufacture lateral access', async () => {
  const app = await start();
  try {
    const one = await app.upload('one.png'); const two = await app.upload('two.png');
    const p = await app.paper([asset(one)]); const q = await app.paper([asset(two)]);
    assert.equal((await app.attachment(one, q.revision.id, 'attach')).status, 200); assert.equal((await app.attachment(two, p.revision.id, 'attach')).status, 200);
    assert.equal((await app.attachment(one, p.revision.id, 'detach')).status, 200); assert.equal((await app.attachment(two, q.revision.id, 'detach')).status, 200);
    for (const path of [`/api/revisions/${p.revision.id}`, `/api/revisions/${q.revision.id}`, `/api/files/${one.id}`, `/api/files/${two.id}`]) assert.equal((await app.request(path, 'GET', undefined, 'bob')).status, 404, path);
    const target = app.store.createTask({ title: 'Grounded grant' }); assert.equal((await app.attachment(one, target.id, 'attach')).status, 200);
    assert.equal((await app.request(`/api/revisions/${p.revision.id}`, 'GET', undefined, 'bob')).status, 200); assert.equal((await app.request(`/api/revisions/${q.revision.id}`, 'GET', undefined, 'bob')).status, 200);
    assert.equal((await app.attachment(one, target.id, 'detach')).status, 200);
    const r = await app.paper([asset(one, 'one.png'), asset(two, 'two.png')]);
    const space = app.policies.createSpace({ name: 'Second figure restriction', view: members(app.alice.id), edit: members(app.alice.id) }, app.alice.id); app.policy(two.id, { spaceId: space.id });
    for (const path of [`/api/revisions/${r.revision.id}`, `/api/files/${one.id}`, `/api/files/${two.id}`]) assert.equal((await app.request(path, 'GET', undefined, 'bob')).status, 404, path);
    assert.equal((await app.attachment(one, target.id, 'attach')).status, 200);
    assert.equal((await app.request(`/api/files/${one.id}`, 'GET', undefined, 'bob')).status, 200);
    assert.equal((await app.request(`/api/revisions/${r.revision.id}`, 'GET', undefined, 'bob')).status, 404);
    assert.equal((await app.request(`/api/files/${two.id}`, 'GET', undefined, 'bob')).status, 404);
  } finally { await app.close(); }
});

function compiler(): PaperRunner {
  const toolchain = { engine: 'file-access-test-double', image: 'sha256:' + '1'.repeat(64), bundle: 'sha256:' + '2'.repeat(64) };
  return { toolchain, async run(input) {
    const artifacts: Awaited<ReturnType<PaperRunner['run']>>['artifacts'] = [
      { kind: 'pdf', name: 'paper.pdf', mediaType: 'application/pdf', data: Buffer.from('%PDF-1.7\nAccess-control fixture; not typeset output.\n%%EOF\n') },
      { kind: 'log', name: 'compiler.log', mediaType: 'text/plain', data: Buffer.from('Access-control fixture') },
      { kind: 'synctex', name: 'paper.synctex.gz', mediaType: 'application/gzip', data: Buffer.from('Fixture map bytes') },
      { kind: 'mapping', name: 'mapping.json', mediaType: 'application/json', data: Buffer.from(JSON.stringify({ origin: 'top-left', units: 'pt', pages: [{ page: 1, width: 612, height: 792 }], points: [{ path: 'main.tex', line: 1, page: 1, x: 10, y: 20, width: 30, height: 12 }] })) },
    ];
    const manifest = { schema: input.assets?.length ? 2 : 1, revisionId: input.revisionId, versionId: input.versionId, contentHash: input.contentHash, entrypoint: input.entrypoint, toolchain,
      files: [...input.files].sort((a, b) => a.path < b.path ? -1 : 1).map(file => ({ path: file.path, sha256: digest(file.content), bytes: Buffer.byteLength(file.content) })),
      ...(input.assets?.length ? { assets: input.assets.map(({ path, fileId, sha256, bytes, mediaType }) => ({ path, fileId, sha256, bytes, mediaType })).sort((a, b) => a.path < b.path ? -1 : 1) } : {}),
      artifacts: artifacts.map(item => ({ kind: item.kind, sha256: digest(item.data), bytes: item.data.byteLength })).sort((a, b) => a.kind < b.kind ? -1 : 1) };
    artifacts.push({ kind: 'manifest', name: 'manifest.json', mediaType: 'application/json', data: Buffer.from(JSON.stringify(manifest)) });
    return { success: true, artifacts, diagnostics: [], error: null };
  } };
}

test('published PDF, manifest and source maps inherit current historical figure and repository access on every endpoint', async () => {
  const app = await start({ paperRunner: compiler() });
  try {
    const repository = app.store.createRepository({ name: 'Paper source', remoteUrl: 'https://example.invalid/paper.git' }); const file = await app.upload();
    const initial = await app.paper([asset(file)], { repositoryId: repository.id }); const id = initial.revision.id; const pinned = version(initial); const route = `/api/revisions/${id}/paper-builds`;
    const created = await app.request<PaperBuild>(route, 'POST', { versionId: pinned.id, contentHash: pinned.contentHash, entrypoint: 'main.tex', toolchainId: app.paperBuilds.configuration.toolchainId }, 'alice', 'build'); assert.equal(created.status, 201);
    let completed: PaperBuild | undefined;
    for (let i = 0; i < 200; i++) { completed = (await app.request<PaperBuildDetail>(`${route}/${created.body.id}`)).body.build; if (completed.status !== 'queued' && completed.status !== 'running') break; await delay(10); }
    assert.equal(completed?.status, 'succeeded', completed?.error ?? 'Build did not finish');
    const paths = [route, `${route}/${created.body.id}`, `${route}/${created.body.id}/synctex`, ...['pdf', 'manifest', 'mapping', 'log', 'synctex'].map(kind => `${route}/${created.body.id}/artifacts/${kind}`)];
    for (const path of paths) { const response = await app.raw(path, 'GET', undefined, 'bob'); assert.equal(response.status, 200, path); await response.arrayBuffer(); }
    assert.equal((await app.attachment(file, id, 'detach')).status, 200);
    for (const path of paths) assert.equal((await app.request(path, 'GET', undefined, 'bob')).status, 404, path);
    assert.equal((await app.attachment(file, id, 'attach')).status, 200);
    app.policy(repository.id, { view: members(app.alice.id), edit: members(app.alice.id) });
    for (const path of paths) assert.equal((await app.request(path, 'GET', undefined, 'bob')).status, 404, path);
    app.policy(repository.id, { view: workspace });
    const pdf = await app.raw(`${route}/${created.body.id}/artifacts/pdf`, 'GET', undefined, 'bob'); assert.equal(pdf.status, 200); assert.equal(pdf.headers.get('x-access-epoch'), String(app.policies.epoch())); await pdf.arrayBuffer();
    const space = app.policies.createSpace({ name: 'Private source bytes', view: members(app.alice.id), edit: members(app.alice.id) }, app.alice.id); app.policy(file.id, { spaceId: space.id });
    for (const path of paths) assert.equal((await app.request(path, 'GET', undefined, 'bob')).status, 404, path);
  } finally { await app.close(); }
});
