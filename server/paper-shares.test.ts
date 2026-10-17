import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from './app.ts';
import { createAuth } from './auth.ts';
import { Store } from './store.ts';
import type { ActorAttribution, RevisionDetail } from '../shared/types.ts';
import type { PaperShareLink, PaperShareList, SharedPaper } from '../shared/paper-shares.ts';
import type { FileRecord } from '../shared/files.ts';

const members = (...principalIds: string[]) => ({ kind: 'principals' as const, principalIds });
const workspace = { kind: 'workspace' as const };
const secret = () => randomBytes(32).toString('base64url');
type ErrorBody = { error: string; code?: string };
async function fixture(basePath = '/', databasePath = ':memory:') {
  const store = new Store({ path: databasePath });
  const provision = createAuth({ database: store.database, mode: 'local', basePath: '/', provisioning: true });
  const alice = await provision.createAccount({ username: 'alice', displayName: 'Private Author', password: 'Alice paper sharing password long enough' });
  const bob = await provision.createAccount({ username: 'bob', displayName: 'Private Reviewer', password: 'Bob paper sharing password long enough' });
  const app = createApp({ store, seed: false, authMode: 'password', basePath });
  const tokens = { alice: app.auth.createToken(alice.id, { name: 'Author', scopes: ['read', 'write'] }), bob: app.auth.createToken(bob.id, { name: 'Reviewer', scopes: ['read', 'write'] }), reader: app.auth.createToken(alice.id, { name: 'Read only', scopes: ['read'] }) };
  const actor: ActorAttribution = { principalId: alice.id, displayName: alice.displayName, credentialId: tokens.alice.record.id, requestId: randomUUID() };
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}${basePath.replace(/\/$/, '')}`;
  async function request<T = ErrorBody>(path: string, method = 'GET', body?: unknown, who: keyof typeof tokens | null = 'alice', key?: string, extraHeaders: Record<string, string> = {}) {
    const response = await fetch(origin + path, { method, signal: AbortSignal.timeout(30_000), headers: { ...(who ? { Authorization: `Bearer ${tokens[who].token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}), ...extraHeaders }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as T, headers: response.headers };
  }
  const policy = (id: string, rules: Record<string, unknown>) => { const current = app.policies.policy(id, alice.id); return app.policies.setPolicy(id, { expectedVersion: current.version, spaceId: current.spaceId, ...current.rules, ...rules }, alice.id); };
  const createPaper = async (extra = {}) => {
    const response = await request<RevisionDetail>('/api/revisions', 'POST', { title: 'Student manuscript', testPlan: 'Verify exact private manuscript.', kind: 'paper', summary: 'Private assessment notes', files: [{ path: 'main.tex', content: '\\begin{document}\r\nA private proof: $a^2+b^2=c^2$. β😀\r\n\\end{document}\n' }], access: { spaceId: 'S1', view: members(alice.id), edit: members(alice.id), interact: members(alice.id) }, ...extra }, 'alice', randomUUID());
    assert.equal(response.status, 201, JSON.stringify(response.body)); return response.body;
  };
  const path = (id: string) => `/api/revisions/${id}/share-links`;
  const input = (detail: RevisionDetail, token = secret()) => ({ token, versionId: detail.versions.at(-1)!.id, contentHash: detail.versions.at(-1)!.contentHash, label: 'Student reading copy' });
  const share = async (detail: RevisionDetail, who: 'alice' | 'bob' = 'alice') => { const value = input(detail), key = randomUUID(), response = await request<PaperShareLink>(path(detail.revision.id), 'POST', value, who, key); assert.equal(response.status, 201, JSON.stringify(response.body)); return { value, key, link: response.body }; };
  return { ...app, tokens, alice, bob, actor, request, origin, policy, createPaper, path, input, share, close: async () => { await app.close(); store.close(); } };
}

for (const basePath of ['/', '/workspace/']) test(`paper share capability loads a private immutable projection at ${basePath} without weakening ordinary access`, async () => {
  const app = await fixture(basePath);
  try {
    const detail = await app.createPaper(), id = detail.revision.id;
    app.store.createComment(id, { body: 'Private grading comment', versionId: detail.versions[0]!.id }, app.actor);
    const shared = await app.share(detail);
    for (const who of [null, 'bob'] as const) {
      assert.equal((await app.request(`/api/revisions/${id}`, 'GET', undefined, who)).status, who === null ? 401 : 404);
      assert.equal((await app.request(app.path(id), 'GET', undefined, who)).status, who === null ? 401 : 404);
    }
    for (const route of ['/api/state', '/api/search?text=Student']) {
      const hidden = await app.request<Record<string, unknown>>(route, 'GET', undefined, 'bob');
      assert.equal(hidden.status, 200); assert.equal(JSON.stringify(hidden.body).includes('Student manuscript'), false); assert.equal(JSON.stringify(hidden.body).includes('Private grading comment'), false);
    }
    assert.equal((await app.request(`/api/revisions/${id}?token=${shared.value.token}`, 'GET', undefined, 'bob')).status, 404);
    assert.equal((await app.request(`/api/revisions/${id}`, 'GET', undefined, null, undefined, { Authorization: `Bearer ${shared.value.token}` })).status, 401);
    const read = await app.request<SharedPaper>('/api/paper-shares/read', 'POST', { token: shared.value.token }, null);
    assert.equal(read.status, 200); assert.deepEqual(read.body, { title: 'Student manuscript', versionNumber: 1, contentHash: detail.versions[0]!.contentHash, files: detail.versions[0]!.files });
    assert.equal(read.headers.get('cache-control'), 'no-store'); assert.equal(read.headers.get('referrer-policy'), 'no-referrer'); assert.equal(read.headers.get('x-robots-tag'), 'noindex, noarchive, nofollow');
    for (const privateValue of [id, app.alice.id, 'Private grading comment', 'Private assessment notes', detail.versions[0]!.id]) assert.equal(JSON.stringify(read.body).includes(privateValue), false);
    const versionTwo = await app.request<RevisionDetail>(`/api/revisions/${id}/versions`, 'POST', { files: [{ path: 'main.tex', content: 'New private changes' }], expectedVersion: 1, message: 'Private version message' }, 'alice', randomUUID());
    assert.equal(versionTwo.status, 201, JSON.stringify(versionTwo.body));
    app.store.database.prepare("UPDATE entities SET data=json_set(data,'$.title','Later private title') WHERE id=?").run(id);
    assert.deepEqual((await app.request<SharedPaper>('/api/paper-shares/read', 'POST', { token: shared.value.token }, null)).body, read.body);
    assert.equal((await app.request(`/api/revisions/${id}/versions`, 'POST', { files: [{ path: 'main.tex', content: 'Unauthorized' }], expectedVersion: 2, message: '' }, null)).status, 401);
    assert.equal((await app.request('/api/paper-shares/read', 'POST', { token: shared.value.token }, null, undefined, { Origin: 'https://unrelated.invalid' })).status, 403);
  } finally { await app.close(); }
});

test('sharing credentials never enter saved rows or receipts; exact retries are safe and changed retries fail', async () => {
  const app = await fixture();
  try {
    const paper = await app.createPaper(), shared = await app.share(paper), route = app.path(paper.revision.id);
    const repeated = await app.request<PaperShareLink>(route, 'POST', shared.value, 'alice', shared.key);
    assert.equal(repeated.status, 200); assert.deepEqual(repeated.body, shared.link);
    assert.equal((await app.request(route, 'POST', { ...shared.value, label: 'Changed' }, 'alice', shared.key)).status, 409);
    assert.equal((await app.request(route, 'POST', shared.value, 'alice', randomUUID())).status, 409);
    assert.equal((await app.request(route, 'POST', { ...shared.value, token: secret(), contentHash: '0'.repeat(64) }, 'alice', randomUUID())).status, 404);
    assert.equal((await app.request(route, 'POST', { ...shared.value, token: secret() }, 'alice')).status, 400);
    assert.equal((await app.request(route, 'GET', undefined, 'reader')).status, 403);
    for (const table of ['paper_share_links', 'paper_share_operations', 'idempotency', 'activity']) {
      const serialized = JSON.stringify(app.store.database.prepare(`SELECT * FROM ${table}`).all());
      assert.equal(serialized.includes(shared.value.token), false, table);
    }
    const stored = app.store.database.prepare('SELECT token_sha256 FROM paper_share_links WHERE id=?').get(shared.link.id);
    assert.equal(stored!.token_sha256, createHash('sha256').update(shared.value.token).digest('hex'));
    const listing = await app.request<PaperShareList>(route); assert.deepEqual(listing.body.links, [shared.link]); assert.equal(JSON.stringify(listing.body).includes(shared.value.token), false);
  } finally { await app.close(); }
});

test('a shared paper does not expose its private original PDF or attachment identities', async () => {
  const app = await fixture();
  try {
    const bytes = Buffer.from('%PDF-1.4\nPrivate student submission\n');
    const uploaded = await app.request<FileRecord>('/api/files', 'POST', { name: 'original-submission.pdf', dataBase64: bytes.toString('base64'), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }, 'alice', randomUUID());
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
    const file = uploaded.body;
    const paper = await app.createPaper({ assets: [{ path: 'figures/original.pdf', fileId: file.id, sha256: file.sha256, bytes: file.bytes, mediaType: file.mediaType }], shareAssets: true, expectedAccessEpoch: app.policies.epoch() });
    const shared = await app.share(paper), read = await app.request<SharedPaper>('/api/paper-shares/read', 'POST', { token: shared.value.token }, null);
    assert.equal(read.status, 200); assert.deepEqual(read.body.files, paper.versions[0]!.files);
    assert.equal(JSON.stringify(read.body).includes(file.id), false); assert.equal(JSON.stringify(read.body).includes('Private student submission'), false); assert.equal('assets' in read.body, false);
    assert.equal((await app.request(`/api/files/${file.id}`, 'GET', undefined, 'bob')).status, 404);
    assert.equal((await app.request(`/api/files/${file.id}?token=${shared.value.token}`, 'GET', undefined, null)).status, 401);
  } finally { await app.close(); }
});

test('revoking a share preserves the manuscript and permanently closes that link, including after restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'paper-share-restart-')), databasePath = join(directory, 'workspace.sqlite');
  const app = await fixture('/', databasePath); let closed = false;
  try {
    const paper = await app.createPaper(), shared = await app.share(paper), active = await app.share(paper), before = app.store.detail(paper.revision.id);
    const route = `${app.path(paper.revision.id)}/${shared.link.id}/revoke`, key = randomUUID();
    const revoked = await app.request<PaperShareLink>(route, 'POST', {}, 'alice', key);
    assert.equal(revoked.status, 200); assert.ok(revoked.body.revokedAt); assert.deepEqual(app.store.detail(paper.revision.id), before);
    assert.deepEqual((await app.request<PaperShareLink>(route, 'POST', {}, 'alice', key)).body, revoked.body);
    assert.deepEqual((await app.request<PaperShareLink>(app.path(paper.revision.id), 'POST', shared.value, 'alice', shared.key)).body, revoked.body);
    const absent = await app.request('/api/paper-shares/read', 'POST', { token: secret() }, null);
    assert.deepEqual(await app.request('/api/paper-shares/read', 'POST', { token: shared.value.token }, null).then(result => ({ status: result.status, body: result.body })), { status: absent.status, body: absent.body });
    assert.equal(absent.status, 404);
    assert.throws(() => app.store.database.prepare('UPDATE paper_share_links SET revoked_at=NULL WHERE id=?').run(shared.link.id), /permanent/);
    await app.close(); closed = true;
    const reopened = createApp({ databasePath, seed: false, authMode: 'password' });
    try {
      await new Promise<void>(resolve => reopened.server.listen(0, '127.0.0.1', resolve));
      const response = await fetch(`http://127.0.0.1:${(reopened.server.address() as AddressInfo).port}/api/paper-shares/read`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: shared.value.token }) });
      assert.equal(response.status, 404); assert.deepEqual(reopened.store.detail(paper.revision.id), before);
      const preserved = await fetch(`http://127.0.0.1:${(reopened.server.address() as AddressInfo).port}/api/paper-shares/read`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: active.value.token }) });
      assert.equal(preserved.status, 200); assert.deepEqual((await preserved.json() as SharedPaper).files, paper.versions[0]!.files);
    } finally { await reopened.close(); }
  } finally { if (!closed) await app.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('sharing authority follows enabled creators and current paper, Space, and repository permissions', async () => {
  const app = await fixture();
  try {
    const paper = await app.createPaper(), id = paper.revision.id;
    app.policy(id, { view: workspace, edit: workspace });
    const shared = await app.share(paper, 'bob');
    const read = () => app.request('/api/paper-shares/read', 'POST', { token: shared.value.token }, null);
    assert.equal((await read()).status, 200);
    app.policy(id, { edit: members(app.alice.id) }); assert.equal((await read()).status, 404);
    app.policy(id, { edit: workspace }); assert.equal((await read()).status, 200);
    app.auth.setAccountDisabled(app.bob.id, true); assert.equal((await read()).status, 404);
    app.auth.setAccountDisabled(app.bob.id, false); assert.equal((await read()).status, 200);
    const space = app.policies.getSpace('S1', app.alice.id);
    app.policies.updateSpace('S1', { expectedVersion: space.version, view: members(app.alice.id) }, app.alice.id);
    assert.equal((await read()).status, 404);
    const updated = app.policies.getSpace('S1', app.alice.id);
    app.policies.updateSpace('S1', { expectedVersion: updated.version, view: workspace }, app.alice.id);
    const repository = app.store.createRepository({ name: 'Private dependency', remoteUrl: 'https://example.invalid/private.git' }, app.actor);
    const linked = await app.createPaper({ repositoryId: repository.id }); app.policy(linked.revision.id, { view: workspace, edit: workspace });
    // Bob's old token was revoked when disabled; use a fresh credential.
    app.tokens.bob = app.auth.createToken(app.bob.id, { name: 'Restored reviewer', scopes: ['read', 'write'] });
    const linkedShare = await app.share(linked, 'bob');
    app.policy(repository.id, { view: members(app.alice.id) });
    assert.equal((await app.request('/api/paper-shares/read', 'POST', { token: linkedShare.value.token }, null)).status, 404);
    const revoke = await app.request(`${app.path(id)}/${shared.link.id}/revoke`, 'POST', {}, 'alice', randomUUID()); assert.equal(revoke.status, 200, 'another current manager may revoke the disabled creator’s link');
  } finally { await app.close(); }
});

test('anonymous links retain historical File Space boundaries after the current paper removes that PDF', async () => {
  const app = await fixture();
  try {
    const bytes = Buffer.from('%PDF-1.4\nOriginal private student submission\n');
    const uploaded = await app.request<FileRecord>('/api/files', 'POST', { name: 'original.pdf', dataBase64: bytes.toString('base64'), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }, 'alice', randomUUID());
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
    const file = uploaded.body;
    const initial = await app.createPaper({ assets: [{ path: 'original.pdf', fileId: file.id, sha256: file.sha256, bytes: file.bytes, mediaType: file.mediaType }], shareAssets: true, expectedAccessEpoch: app.policies.epoch() });
    const id = initial.revision.id; app.policy(id, { view: workspace, edit: workspace });
    const oldShare = await app.share(initial, 'bob');
    const updated = await app.request<RevisionDetail>(`/api/revisions/${id}/versions`, 'POST', { files: [{ path: 'main.tex', content: 'Current text without PDF figures: $x^2$.\n' }], assets: [], expectedAccessEpoch: app.policies.epoch(), expectedVersion: 1, expectedVersionId: initial.versions[0]!.id, expectedContentHash: initial.versions[0]!.contentHash, message: 'Remove PDF from the current version' }, 'alice', randomUUID());
    assert.equal(updated.status, 201, JSON.stringify(updated.body)); assert.deepEqual(updated.body.versions.at(-1)!.assets ?? [], []);
    const currentShare = await app.share(updated.body, 'bob');
    const read = (token: string) => app.request<SharedPaper>('/api/paper-shares/read', 'POST', { token }, null);
    assert.equal((await read(oldShare.value.token)).status, 200); assert.equal((await read(currentShare.value.token)).status, 200);
    const preserved = app.store.detail(id);
    const space = app.policies.createSpace({ name: 'Private original submission', view: members(app.alice.id), edit: members(app.alice.id) }, app.alice.id);
    app.policy(file.id, { spaceId: space.id });
    for (const shared of [oldShare, currentShare]) {
      const denied = await read(shared.value.token); assert.equal(denied.status, 404);
      assert.equal(JSON.stringify(denied.body).includes('Current text'), false); assert.equal(JSON.stringify(denied.body).includes('private proof'), false);
    }
    assert.equal((await app.request(`/api/revisions/${id}`, 'GET', undefined, 'bob')).status, 404);
    assert.equal((await app.request(`/api/files/${file.id}/data`, 'GET', undefined, 'bob')).status, 404);
    assert.deepEqual(app.store.detail(id), preserved, 'File restrictions must not rewrite the manuscript or its source history');
    app.policy(file.id, { spaceId: 'S1' });
    assert.equal((await read(oldShare.value.token)).status, 200); assert.equal((await read(currentShare.value.token)).status, 200);
    assert.deepEqual(app.store.detail(id), preserved);
  } finally { await app.close(); }
});

test('sharing pagination is bounded without limiting link creation and rejects ambiguous route inputs', async () => {
  const app = await fixture();
  try {
    const paper = await app.createPaper(), route = app.path(paper.revision.id), links = [];
    for (let index = 0; index < 3; index++) links.push((await app.share(paper)).link);
    const first = await app.request<PaperShareList>(`${route}?limit=2`); assert.equal(first.body.links.length, 2); assert.ok(first.body.nextCursor);
    const last = await app.request<PaperShareList>(`${route}?limit=2&before=${first.body.nextCursor}`); assert.deepEqual([...first.body.links, ...last.body.links].map(link => link.id), links.reverse().map(link => link.id)); assert.equal(last.body.nextCursor, null);
    for (const query of ['limit=101', 'limit=1&limit=2', 'before=0', 'before=1&before=2', 'token=secret']) assert.equal((await app.request(`${route}?${query}`)).status, 400);
    for (const token of ['', 'x'.repeat(43), 'a'.repeat(42), 'a'.repeat(44), 'abc/def', null]) assert.equal((await app.request('/api/paper-shares/read', 'POST', { token }, null)).status, 404);
    assert.equal((await app.request('/api/paper-shares/read?token=bad', 'POST', { token: secret() }, null)).status, 400);
    assert.equal((await app.request('/api/paper-shares/read', 'POST', { token: secret(), ignored: 'x'.repeat(600) }, null)).status, 413);
    assert.equal((await app.request('/api/paper-shares/read', 'GET', undefined, null)).status, 404);
    const code = app.store.createRevision({ title: 'Code', testPlan: 'Inspect.', kind: 'code', files: [{ path: 'a.ts', content: 'private' }] }, app.actor);
    assert.equal((await app.request(app.path(code.revision.id), 'POST', app.input(code), 'alice', randomUUID())).status, 404);
  } finally { await app.close(); }
});

const snapshot = (db: DatabaseSync) => (db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string; sql: string }[]).map(row => ({ ...row, rows: db.prepare(`SELECT * FROM "${row.name.replaceAll('"', '""')}" ORDER BY rowid`).all() }));
function downgrade(db: DatabaseSync): void { db.exec('DROP TABLE paper_share_operations; DROP TABLE paper_share_links; PRAGMA user_version=46;'); }
test('paper sharing migration preserves old source and receipt evidence and survives reopen', () => {
  const directory = mkdtempSync(join(tmpdir(), 'paper-share-migrate-')), path = join(directory, 'workspace.sqlite'); let store = new Store({ path });
  try {
    store.createRevision({ title: 'Preserved paper', testPlan: 'Inspect.', kind: 'paper', files: [{ path: 'main.tex', content: 'Exact old math $x^2$.\r\n' }] });
    downgrade(store.database); const before = snapshot(store.database); store.close(); store = new Store({ path });
    assert.equal(store.database.prepare('PRAGMA user_version').get()!.user_version, 47);
    const after = snapshot(store.database); for (const row of before) assert.deepEqual(after.find(item => item.name === row.name), row);
    assert.equal(after.length, before.length + 2); assert.deepEqual(store.database.prepare('PRAGMA foreign_key_check').all(), []);
    store.close(); store = new Store({ path }); assert.deepEqual(snapshot(store.database), after);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
test('paper sharing migration completes a compatible partial schema without replacing old records', () => {
  const directory = mkdtempSync(join(tmpdir(), 'paper-share-partial-')), path = join(directory, 'workspace.sqlite'); let store = new Store({ path });
  try {
    store.createRevision({ title: 'Old paper', testPlan: 'Inspect.', kind: 'paper', files: [{ path: 'main.tex', content: 'Retain exact source $x$.\n' }] });
    store.database.exec('DROP TABLE paper_share_operations; PRAGMA user_version=46;');
    const before = snapshot(store.database); store.close(); store = new Store({ path });
    assert.equal(store.database.prepare('PRAGMA user_version').get()!.user_version, 47);
    const after = snapshot(store.database); for (const row of before) assert.deepEqual(after.find(item => item.name === row.name), row);
    assert.equal(after.length, before.length + 1); assert.deepEqual(store.database.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
for (const collision of ['table', 'index', 'trigger']) test(`paper sharing migration rejects a conflicting ${collision} and rolls back`, () => {
  const directory = mkdtempSync(join(tmpdir(), 'paper-share-collision-')), path = join(directory, 'workspace.sqlite'), store = new Store({ path });
  downgrade(store.database);
  store.database.exec({ table: "CREATE TABLE paper_share_links(note TEXT); INSERT INTO paper_share_links VALUES('Do not lose this')", index: 'CREATE INDEX paper_share_revision ON entities(kind)', trigger: 'CREATE TRIGGER paper_share_identity BEFORE DELETE ON entities BEGIN SELECT 1; END' }[collision]!);
  const before = snapshot(store.database); store.close();
  try {
    assert.throws(() => new Store({ path }), /Unexpected paper_share_/);
    const database = new DatabaseSync(path); try { assert.equal(database.prepare('PRAGMA user_version').get()!.user_version, 46); assert.deepEqual(snapshot(database), before); } finally { database.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('paper sharing migration rolls back new tables when the schema fence cannot commit', () => {
  const directory = mkdtempSync(join(tmpdir(), 'paper-share-rollback-')), path = join(directory, 'workspace.sqlite'), store = new Store({ path }), exec = DatabaseSync.prototype.exec;
  store.createTask({ title: 'Keep prior records' }); downgrade(store.database);
  const before = snapshot(store.database); store.close();
  try {
    DatabaseSync.prototype.exec = function(sql: string) { if (sql === 'PRAGMA user_version = 47') throw new Error('Injected paper sharing migration failure'); return exec.call(this, sql); };
    assert.throws(() => new Store({ path }), /Injected paper sharing migration failure/);
  } finally { DatabaseSync.prototype.exec = exec; }
  try {
    const database = new DatabaseSync(path);
    try { assert.equal(database.prepare('PRAGMA user_version').get()!.user_version, 46); assert.deepEqual(snapshot(database), before); }
    finally { database.close(); }
    const repaired = new Store({ path }); try { assert.equal(repaired.database.prepare('PRAGMA user_version').get()!.user_version, 47); } finally { repaired.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
