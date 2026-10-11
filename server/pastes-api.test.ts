import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { createApp } from './app.ts';
import { createAuth } from './auth.ts';
import { Store } from './store.ts';
import { PASTE_MAX_BYTES, type CreatePasteInput, type PasteDetail, type PasteHistory, type PastePage, type PasteRecord, type PasteTransaction, type PasteVersion, type PasteVersionsPage } from '../shared/pastes.ts';
import type { FileRecord } from '../shared/files.ts';
import type { AppState } from '../shared/types.ts';

const workspace = { kind: 'workspace' as const }, members = (...principalIds: string[]) => ({ kind: 'principals' as const, principalIds });
const content = '\uFEFF  <script>alert("not executable")</script>\r\n\rA 🦆 line\n  ';
const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
type Failure = { error: string; code?: string };
type SavedPaste = PasteRecord & { accessEpoch: number };

async function start(path = ':memory:') {
  const store = new Store({ path });
  const provision = createAuth({ database: store.database, mode: 'local', basePath: '/', provisioning: true });
  const alice = await provision.createAccount({ username: 'alice', displayName: 'Alice', password: 'Alice paste API test password' });
  const bob = await provision.createAccount({ username: 'bob', displayName: 'Bob', password: 'Bob paste API test password' });
  const app = createApp({ store, seed: false, authMode: 'password' });
  const tokens = { alice: app.auth.createToken(alice.id, { name: 'Alice', scopes: ['read', 'write'] }), aliceOther: app.auth.createToken(alice.id, { name: 'Other Alice', scopes: ['read', 'write'] }), bob: app.auth.createToken(bob.id, { name: 'Bob', scopes: ['read', 'write'] }), reader: app.auth.createToken(alice.id, { name: 'Read only', scopes: ['read'] }) };
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  async function response(path: string, method = 'GET', body?: unknown, actor: keyof typeof tokens | null = 'alice', key?: string) {
    return fetch(origin + path, { method, signal: AbortSignal.timeout(15_000), headers: { ...(actor ? { Authorization: `Bearer ${tokens[actor].token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  async function request<T = Failure>(path: string, method = 'GET', body?: unknown, actor: keyof typeof tokens | null = 'alice', key?: string) { const reply = await response(path, method, body, actor, key); return { status: reply.status, headers: reply.headers, body: await reply.json() as T }; }
  function policy(id: string, patch: Record<string, unknown>, actor = alice.id) { const current = app.policies.policy(id, actor); return app.policies.setPolicy(id, { expectedVersion: current.version, spaceId: current.spaceId, ...current.rules, ...patch }, actor); }
  let sequence = 0;
  async function paste(patch: Partial<CreatePasteInput> = {}, actor: keyof typeof tokens = 'alice') { const made = await request<SavedPaste>('/api/pastes', 'POST', { content, title: 'A Paste', ...patch }, actor, `create-${++sequence}`); assert.equal(made.status, 201, JSON.stringify(made.body)); return made.body; }
  const rows = (table: string) => store.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
  return { ...app, alice, bob, tokens, origin, request, response, policy, paste, rows, close: async () => { await app.close(); store.close(); } };
}

test('Paste creation requires authenticated write authority and authors retain access only inside their Space', async () => {
  const app = await start();
  try {
    assert.equal((await app.request('/api/pastes', 'POST', { content }, null, 'anonymous')).status, 401);
    assert.equal((await app.request('/api/pastes', 'POST', { content }, 'reader', 'read-only')).status, 403);
    assert.equal((await app.request('/api/pastes', 'POST', { content })).status, 400);
    const paste = await app.paste({ title: 'Hidden source title', access: { spaceId: 'S1', view: members(), edit: members(), interact: members() } });
    assert.match(paste.id, /^PA\d+$/); const detail = await app.request<PasteDetail>(`/api/pastes/${paste.id}`); assert.equal(detail.status, 200); assert.equal(detail.body.access?.automatic?.kind, 'paste-author'); assert.equal(detail.body.access?.capabilities.edit, true);
    for (const route of [`/api/pastes/${paste.id}`, `/api/pastes/${paste.id}/versions/1`, `/api/pastes/${paste.id}/versions`, `/api/pastes/${paste.id}/history`, `/api/pastes/${paste.id}/raw?version=1`]) assert.equal((await app.response(route, 'GET', undefined, 'bob')).status, 404, route);
    const bob = await app.request<AppState>('/api/state', 'GET', undefined, 'bob'); assert.ok(!JSON.stringify(bob.body).includes('Hidden source title')); assert.equal((bob.body.pastes ?? []).some(item => item.id === paste.id), false);
    const space = app.policies.createSpace({ name: 'Paste boundary', view: workspace, edit: members(app.alice.id, app.bob.id) }, app.alice.id); app.policy(paste.id, { spaceId: space.id });
    app.policies.updateSpace(space.id, { expectedVersion: space.version, view: members(app.bob.id), edit: members(app.bob.id) }, app.bob.id);
    assert.equal((await app.request(`/api/pastes/${paste.id}`)).status, 404); assert.equal((await app.request(`/api/pastes/${paste.id}`, 'PATCH', { expectedVersion: 1, title: 'Denied author' }, 'alice', 'author-edit')).status, 404);
  } finally { await app.close(); }
});

test('Paste content and comments retain exact historical versions while metadata and archive state advance separately', async () => {
  const app = await start();
  try {
    const paste = await app.paste({ language: 'typescript' }), route = `/api/pastes/${paste.id}`;
    const title = await app.request<SavedPaste>(route, 'PATCH', { expectedVersion: 1, title: '  A renamed Paste  ', language: null }, 'alice', 'rename'); assert.equal(title.status, 200); assert.equal(title.body.title, 'A renamed Paste'); assert.equal(title.body.version, 2); assert.equal(title.body.contentVersion, 1);
    const changed = await app.request<SavedPaste>(route, 'PATCH', { expectedVersion: 2, content: 'New exact content\r\n' }, 'alice', 'change'); assert.equal(changed.status, 200); assert.equal(changed.body.version, 3); assert.equal(changed.body.contentVersion, 2);
    const old = await app.request<{ version: PasteVersion }>(`${route}/versions/1`); assert.equal(old.body.version.content, content); assert.equal(old.body.version.sha256, sha(content));
    const comment = await app.request<PasteTransaction>(`${route}/comments`, 'POST', { contentVersion: 1, body: '  This refers to the old snapshot.\n' }, 'bob', 'old-comment'); assert.equal(comment.status, 201); assert.equal(comment.body.contentVersion, 1); assert.equal(comment.body.contentHash, sha(content)); assert.equal(comment.body.comment, 'This refers to the old snapshot.');
    const archived = await app.request<SavedPaste>(route, 'PATCH', { expectedVersion: 3, status: 'archived' }, 'alice', 'archive'); assert.equal(archived.status, 200); assert.equal(archived.body.version, 4); assert.equal(archived.body.contentVersion, 2);
    assert.equal((await app.request<PasteDetail>(route)).body.paste.status, 'archived'); assert.equal((await app.request<{ version: PasteVersion }>(`${route}/versions/1`)).body.version.content, content);
    const history = await app.request<PasteHistory>(`${route}/history?limit=2`); assert.equal(history.status, 200); assert.equal(history.body.transactions.length, 2); assert.ok(history.body.nextBefore);
    const older = await app.request<PasteHistory>(`${route}/history?limit=100&before=${history.body.nextBefore}`); assert.ok(older.body.transactions.some(item => item.contentChange?.from === 1 && item.contentChange.to === 2)); assert.ok(older.body.transactions.some(item => item.kind === 'create'));
    const versions = await app.request<PasteVersionsPage>(`${route}/versions?limit=1`); assert.equal(versions.body.versions[0]?.number, 2); assert.equal('content' in versions.body.versions[0]!, false); assert.ok(versions.body.nextBefore);
    assert.equal((await app.request<PasteVersionsPage>(`${route}/versions?limit=1&before=${versions.body.nextBefore}`)).body.versions[0]?.number, 1);
  } finally { await app.close(); }
});

test('Paste raw reads require exact versions, preserve BOM/newlines and cannot execute pasted HTML', async () => {
  const app = await start();
  try {
    const paste = await app.paste(), route = `/api/pastes/${paste.id}`;
    const raw = await app.response(`${route}/raw?version=1`); assert.equal(raw.status, 200); assert.deepEqual(Buffer.from(await raw.arrayBuffer()), Buffer.from(content));
    assert.match(raw.headers.get('content-type')!, /^text\/plain; charset=utf-8$/); assert.match(raw.headers.get('cache-control')!, /private, no-store/); assert.match(raw.headers.get('content-disposition')!, /^attachment;/); assert.equal(raw.headers.get('x-content-type-options'), 'nosniff'); assert.match(raw.headers.get('content-security-policy')!, /sandbox/); assert.equal(raw.headers.get('x-content-sha256'), sha(content)); assert.equal(raw.headers.get('x-content-version'), '1'); assert.equal(raw.headers.get('x-access-epoch'), String(app.policies.epoch()));
    for (const suffix of ['/raw', '/raw?version=0', '/raw?version=1&version=1', '/raw?version=1&extra=x', '/versions/1?version=1', '/versions?limit=101', '/history?before=0', '?extra=x']) assert.equal((await app.request(route + suffix)).status, 400, suffix);
    assert.equal((await app.request(`${route}/versions/99`)).status, 404);
    const worst = '\u0001'.repeat(PASTE_MAX_BYTES); const escaped = await app.paste({ content: worst }); assert.equal(escaped.bytes, PASTE_MAX_BYTES);
    assert.equal((await app.request('/api/pastes', 'POST', { content: worst + 'x' }, 'alice', 'oversize')).status, 400);
  } finally { await app.close(); }
});

test('Paste idempotency is principal-scoped, remains historical after later edits and revalidates revoked writes', async () => {
  const app = await start();
  try {
    const input = { content, title: 'Stable create' };
    const [first, concurrent] = await Promise.all([app.request<SavedPaste>('/api/pastes', 'POST', input, 'alice', 'same'), app.request<SavedPaste>('/api/pastes', 'POST', input, 'aliceOther', 'same')]); assert.equal(first.status, 201); assert.deepEqual(first.body, concurrent.body);
    const other = await app.request<SavedPaste>('/api/pastes', 'POST', input, 'bob', 'same'); assert.equal(other.status, 201); assert.notEqual(first.body.id, other.body.id);
    const route = `/api/pastes/${first.body.id}`, edit = { expectedVersion: 1, title: 'Bob edits' };
    assert.equal((await app.request(route, 'PATCH', edit, 'bob', 'edit')).status, 200);
    const replay = await app.request<SavedPaste>('/api/pastes', 'POST', input, 'aliceOther', 'same'); assert.equal(replay.status, 201); assert.equal(replay.body.title, 'Stable create'); assert.equal(replay.body.version, 1); assert.equal((await app.request<PasteDetail>(route)).body.paste.version, 2);
    assert.equal((await app.request('/api/pastes', 'POST', { ...input, content: 'different' }, 'alice', 'same')).status, 409);
    app.policy(first.body.id, { edit: members(app.alice.id), interact: members(app.alice.id) }); assert.equal((await app.request(route, 'PATCH', edit, 'bob', 'edit')).status, 403);
    app.auth.revokeToken(app.alice.id, app.tokens.aliceOther.record.id); assert.equal((await app.request('/api/pastes', 'POST', input, 'aliceOther', 'same')).status, 401);
    const comment = { contentVersion: 1, body: 'Original author comment' }; assert.equal((await app.request(`${route}/comments`, 'POST', comment, 'alice', 'comment')).status, 201); assert.equal((await app.request(`${route}/comments`, 'POST', { ...comment, body: 'Changed' }, 'alice', 'comment')).status, 409);
  } finally { await app.close(); }
});

test('Paste list pagination excludes hidden records and applies source, author, language, status and date filters', async () => {
  const app = await start();
  try {
    const first = await app.paste({ title: 'First visible', content: 'Needle % literal _ text', language: 'typescript' });
    const hidden = await app.paste({ title: 'Hidden middle', content: 'Private phrase', access: { spaceId: 'S1', view: members(app.bob.id), edit: members(app.bob.id), interact: members(app.bob.id) } }, 'bob');
    const last = await app.paste({ title: 'Last visible', language: 'python' });
    const page = await app.request<PastePage>('/api/pastes?limit=1'); assert.deepEqual(page.body.pastes.map(item => item.id), [last.id]); assert.ok(page.body.nextBefore);
    const next = await app.request<PastePage>(`/api/pastes?limit=1&before=${page.body.nextBefore}`); assert.deepEqual(next.body.pastes.map(item => item.id), [first.id]); assert.equal(next.body.nextBefore, null); assert.ok(!JSON.stringify(page.body).includes(hidden.id));
    const query = new URLSearchParams({ query: '% literal _', authorId: app.alice.id, language: 'typescript', createdAfter: '2000-01-01T00:00:00.000Z', createdBefore: '2100-01-01T00:00:00.000Z' });
    assert.deepEqual((await app.request<PastePage>(`/api/pastes?${query}`)).body.pastes.map(item => item.id), [first.id]);
    await app.request(`/api/pastes/${first.id}`, 'PATCH', { expectedVersion: 1, status: 'archived' }, 'alice', 'archive-first');
    assert.equal((await app.request<PastePage>('/api/pastes')).body.pastes.some(item => item.id === first.id), false); assert.deepEqual((await app.request<PastePage>('/api/pastes?status=archived')).body.pastes.map(item => item.id), [first.id]);
    for (const query of ['limit=101', 'status=invalid', 'before=0', 'query=x&query=y', 'createdAfter=bad', 'unsupported=x']) assert.equal((await app.request(`/api/pastes?${query}`)).status, 400, query);
  } finally { await app.close(); }
});

test('Paste edit no-ops, stale conflicts and invalid comments leave history and idempotency state unchanged', async () => {
  const app = await start();
  try {
    const paste = await app.paste(), route = `/api/pastes/${paste.id}`; const history = await app.request<PasteHistory>(`${route}/history`);
    const noop = await app.request<SavedPaste>(route, 'PATCH', { expectedVersion: 1, title: ' A Paste ', content }, 'alice', 'noop'); assert.equal(noop.status, 200); assert.equal(noop.body.version, 1); assert.deepEqual((await app.request<PasteHistory>(`${route}/history`)).body.transactions, history.body.transactions);
    assert.equal((await app.request(route, 'PATCH', { expectedVersion: 1, title: 'Changed' }, 'alice', 'real')).status, 200);
    const receipts = app.rows('idempotency'); const detail = (await app.request<PasteDetail>(route)).body;
    for (const [suffix, method, body] of [['', 'PATCH', { expectedVersion: 1, content: 'stale' }], ['', 'PATCH', { expectedVersion: 2, content: '\0' }], ['', 'PATCH', { expectedVersion: 2, language: '' }], ['/comments', 'POST', { contentVersion: 99, body: 'Wrong version' }], ['/comments', 'POST', { contentVersion: 1, body: '  ' }]] as const) { assert.ok([400, 404, 409].includes((await app.request(route + suffix, method, body, 'alice', 'failed')).status)); assert.deepEqual(app.rows('idempotency'), receipts); }
    assert.deepEqual((await app.request<PasteDetail>(route)).body, detail);
    app.store.database.exec("CREATE TRIGGER fail_paste_receipt BEFORE INSERT ON idempotency BEGIN SELECT RAISE(ABORT,'injected receipt failure'); END;");
    assert.equal((await app.request(route, 'PATCH', { expectedVersion: 2, content: 'Must roll back' }, 'alice', 'atomic')).status, 500); assert.deepEqual((await app.request<PasteDetail>(route)).body, detail); assert.deepEqual(app.rows('idempotency'), receipts);
  } finally { await app.close(); }
});

test('forged Paste receipts cannot substitute stored metadata or an unrelated comment', async () => {
  const app = await start();
  try {
    const input = { content, title: 'Receipt original' }; const made = await app.request<SavedPaste>('/api/pastes', 'POST', input, 'alice', 'receipt'); assert.equal(made.status, 201); const id = made.body.id, route = `/api/pastes/${id}`;
    const row = app.store.database.prepare("SELECT key,body FROM idempotency WHERE json_extract(body,'$.id')=?").get(id) as { key: string; body: string };
    for (const patch of [{ title: 'Forged' }, { contentHash: '0'.repeat(64) }, { bytes: 99 }, { authorId: app.bob.id }]) { app.store.database.prepare('UPDATE idempotency SET body=? WHERE key=?').run(JSON.stringify({ ...JSON.parse(row.body), ...patch }), row.key); assert.equal((await app.request('/api/pastes', 'POST', input, 'alice', 'receipt')).status, 409); }
    app.store.database.prepare('UPDATE idempotency SET body=? WHERE key=?').run(row.body, row.key); assert.equal((await app.request('/api/pastes', 'POST', input, 'alice', 'receipt')).status, 201);
    const firstInput = { contentVersion: 1, body: 'First observation' }, secondInput = { contentVersion: 1, body: 'Other observation' };
    const first = await app.request<PasteTransaction>(`${route}/comments`, 'POST', firstInput, 'alice', 'first'); const other = await app.request<PasteTransaction>(`${route}/comments`, 'POST', secondInput, 'alice', 'other'); assert.equal(first.status, 201); assert.equal(other.status, 201);
    const saved = app.store.database.prepare("SELECT key,body FROM idempotency WHERE json_extract(body,'$.id')=?").get(first.body.id) as { key: string; body: string };
    app.store.database.prepare('UPDATE idempotency SET body=? WHERE key=?').run(JSON.stringify(other.body), saved.key); assert.equal((await app.request(`${route}/comments`, 'POST', firstInput, 'alice', 'first')).status, 409);
  } finally { await app.close(); }
});

test('Paste edit receipts preserve every omitted field and exact content pins instead of accepting a canonical different transition', async () => {
  const app = await start();
  try {
    for (const [label, original, additional] of [
      ['language', { title: 'A Paste' }, { language: 'latex' }],
      ['status', { title: 'A Paste' }, { status: 'archived' }],
      ['source', { title: 'A Paste' }, { content: 'An unrequested replacement\r\n' }],
      ['metadata', { content }, { title: 'An unrequested title' }],
    ] as const) {
      const paste = await app.paste(), route = `/api/pastes/${paste.id}`, input = { expectedVersion: 1, ...original }, requestKey = `original-${label}`;
      const saved = await app.request<SavedPaste>(route, 'PATCH', input, 'alice', requestKey); assert.equal(saved.status, 200); assert.equal(saved.body.version, 1);
      const row = app.store.database.prepare("SELECT key,body FROM idempotency WHERE json_extract(body,'$.id')=? ORDER BY rowid DESC LIMIT 1").get(paste.id) as { key: string; body: string };
      const other = await app.request<SavedPaste>(route, 'PATCH', { ...input, ...additional }, 'alice', `different-${label}`); assert.equal(other.status, 200); assert.equal(other.body.version, 2);
      app.store.database.prepare('UPDATE idempotency SET body=? WHERE key=?').run(JSON.stringify(other.body), row.key);
      assert.equal((await app.request(route, 'PATCH', input, 'aliceOther', requestKey)).status, 409, `${label}: an exact stored snapshot with an unrequested change is not the original receipt`);
      app.store.database.prepare('UPDATE idempotency SET body=? WHERE key=?').run(row.body, row.key);
      const recovered = await app.request<SavedPaste>(route, 'PATCH', input, 'aliceOther', requestKey); assert.equal(recovered.status, 200); assert.equal(recovered.body.version, 1, 'a legitimate historical no-op survives a later edit');
    }
  } finally { await app.close(); }
});

test('Paste edit receipts bind changed transition actors while allowing another authorized editor to make a no-op', async () => {
  const app = await start();
  try {
    const paste = await app.paste(), route = `/api/pastes/${paste.id}`, noop = { expectedVersion: 1, title: ' A Paste ' };
    const unchanged = await app.request<SavedPaste>(route, 'PATCH', noop, 'bob', 'bob-noop'); assert.equal(unchanged.status, 200); assert.equal(unchanged.body.version, 1, 'base snapshot author does not own a new no-op');
    const aliceNoop = await app.request<SavedPaste>(route, 'PATCH', noop, 'alice', 'alice-original'); assert.equal(aliceNoop.status, 200);
    const row = app.store.database.prepare("SELECT key,body,fingerprint FROM idempotency WHERE json_extract(body,'$.id')=? ORDER BY rowid DESC LIMIT 1").get(paste.id) as { key: string; body: string; fingerprint: string };
    const changed = { expectedVersion: 1, title: 'Bob changed this' }; const bobEdit = await app.request<SavedPaste>(route, 'PATCH', changed, 'bob', 'bob-edit'); assert.equal(bobEdit.status, 200);
    // Both the snapshot and normalized transition are genuine. A fabricated
    // principal-scoped receipt still cannot attribute Bob's edit to Alice.
    const fingerprint = createHash('sha256').update(JSON.stringify(['PATCH', route, changed])).digest('hex');
    app.store.database.prepare('UPDATE idempotency SET body=?,fingerprint=? WHERE key=?').run(JSON.stringify(bobEdit.body), fingerprint, row.key);
    assert.equal((await app.request(route, 'PATCH', changed, 'alice', 'alice-original')).status, 409);
    assert.equal((await app.request(route, 'PATCH', changed, 'bob', 'bob-edit')).status, 200);
    app.store.database.prepare('UPDATE idempotency SET body=?,fingerprint=? WHERE key=?').run(row.body, row.fingerprint, row.key);
    assert.equal((await app.request(route, 'PATCH', noop, 'aliceOther', 'alice-original')).status, 200);
  } finally { await app.close(); }
});

test('explicit File attachments can use Paste audiences, while ordinary references and File Spaces remain separate', async () => {
  const app = await start();
  try {
    const paste = await app.paste(), bytes = Buffer.from('Private attached source');
    const upload = await app.request<FileRecord>('/api/files', 'POST', { name: 'source.txt', dataBase64: bytes.toString('base64'), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }, 'alice', 'upload'); assert.equal(upload.status, 201); const file = upload.body;
    const attach = `/api/files/${file.id}/attachments`; assert.equal((await app.request(attach, 'POST', { objectId: paste.id, mode: 'reference', expectedVersion: 0 }, 'alice', 'reference')).status, 200);
    assert.equal((await app.request(`/api/files/${file.id}`, 'GET', undefined, 'bob')).status, 404);
    assert.equal((await app.request(attach, 'POST', { objectId: paste.id, mode: 'attach', expectedVersion: 1, expectedAccessEpoch: app.policies.epoch() }, 'alice', 'attach')).status, 200);
    assert.equal((await app.request(`/api/files/${file.id}`, 'GET', undefined, 'bob')).status, 200); assert.ok(((await app.request<AppState>('/api/state', 'GET', undefined, 'bob')).body.files ?? []).some(item => item.id === file.id));
    const space = app.policies.createSpace({ name: 'Independent File ceiling', view: members(app.alice.id), edit: members(app.alice.id) }, app.alice.id); app.policy(file.id, { spaceId: space.id });
    assert.equal((await app.request(`/api/files/${file.id}`, 'GET', undefined, 'bob')).status, 404); assert.equal((await app.request(`/api/pastes/${paste.id}`, 'GET', undefined, 'bob')).status, 200);
    app.policy(file.id, { spaceId: 'S1' }); app.policy(paste.id, { view: members(app.alice.id) }); assert.equal((await app.request(`/api/files/${file.id}`, 'GET', undefined, 'bob')).status, 404);
  } finally { await app.close(); }
});

test('saved Paste bytes and immutable history survive closing and reopening the migrated database', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paste-api-reopen-')), path = join(directory, 'workspace.sqlite'); const app = await start(path); let closed = false;
  try {
    const paste = await app.paste(), route = `/api/pastes/${paste.id}`; await app.request(route, 'PATCH', { expectedVersion: 1, content: 'Later content' }, 'alice', 'edit'); await app.request(`${route}/comments`, 'POST', { contentVersion: 1, body: 'Historical observation' }, 'alice', 'comment');
    const before = app.store.pastes.detail(paste.id), receipts = app.rows('idempotency'); await app.close(); closed = true;
    const reopened = new Store({ path }); try { assert.deepEqual(reopened.pastes.detail(paste.id), before); assert.equal(reopened.pastes.version(paste.id, 1).content, content); assert.deepEqual(reopened.database.prepare('SELECT * FROM idempotency ORDER BY rowid').all(), receipts); assert.deepEqual(reopened.database.prepare('PRAGMA foreign_key_check').all(), []); } finally { reopened.close(); }
  } finally { if (!closed) await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Space revocation committed during the writer lock blocks fresh Paste edits and newly available receipts', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paste-api-lock-')), path = join(directory, 'workspace.sqlite'), app = await start(path), transaction = app.store.transaction.bind(app.store);
  try {
    for (const phase of ['fresh', 'replay'] as const) {
      const paste = await app.paste(), route = `/api/pastes/${paste.id}`, key = `locked-${phase}`, input = { expectedVersion: 1, title: 'Bob edits this Paste' };
      let receipt: { key: string; fingerprint: string; status: number; body: string; created_at: string } | undefined;
      if (phase === 'replay') {
        assert.equal((await app.request(route, 'PATCH', input, 'bob', key)).status, 200);
        receipt = app.store.database.prepare("SELECT * FROM idempotency WHERE json_extract(body,'$.id')=? AND json_extract(body,'$.version')=2").get(paste.id) as typeof receipt; assert.ok(receipt); app.store.database.prepare('DELETE FROM idempotency WHERE key=?').run(receipt.key);
      }
      const space = app.policies.createSpace({ name: 'Concurrent Paste boundary', view: workspace, edit: members(app.alice.id, app.bob.id) }, app.alice.id); app.policy(paste.id, { spaceId: space.id });
      const restricted = { ...space, version: space.version + 1, view: members(app.alice.id), edit: members(app.alice.id) }, before = app.store.pastes.detail(paste.id), receipts = app.rows('idempotency').length;
      const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(`
        import { parentPort,workerData } from 'node:worker_threads';
        import { DatabaseSync } from 'node:sqlite';
        const database=new DatabaseSync(workerData.path); database.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
        database.prepare('UPDATE policy_spaces SET data=? WHERE id=?').run(JSON.stringify(workerData.space),workerData.space.id);
        database.prepare("UPDATE policy_meta SET value=value+1 WHERE name='epoch'").run();
        if(workerData.receipt){const row=workerData.receipt;database.prepare('INSERT INTO idempotency(key,fingerprint,status,body,created_at) VALUES(?,?,?,?,?)').run(row.key,row.fingerprint,row.status,row.body,row.created_at);}
        parentPort.once('message',()=>{database.exec('COMMIT');database.close();parentPort.close();}); parentPort.postMessage('locked');
      `)}`), { workerData: { path, space: restricted, receipt } });
      let entered = 0;
      try {
        await once(worker, 'message');
        app.store.transaction = function<T>(work: () => T): T { entered++; app.store.transaction = transaction; worker.postMessage('commit'); return transaction(work); };
        const result = await app.request(route, 'PATCH', input, 'bob', key); assert.equal(entered, 1, JSON.stringify({ phase, result })); assert.equal(result.status, 404);
        assert.deepEqual(app.store.pastes.detail(paste.id), before); assert.equal(app.rows('idempotency').length, receipts + (receipt ? 1 : 0));
      } finally { app.store.transaction = transaction; await worker.terminate(); }
    }
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
