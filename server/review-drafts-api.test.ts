import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp } from './app.ts';
import { createAuth } from './auth.ts';
import { Store } from './store.ts';
import type { ActorAttribution } from '../shared/types.ts';
import type { SessionState } from '../shared/auth.ts';
import type { ReviewDraftChangeReceipt, ReviewDraftDiscovery, ReviewDraftPreview, ReviewDraftPublicationReceipt, ReviewDraftSaveInput, ReviewDraftSnapshot } from '../shared/review-drafts.ts';

const workspace = { kind: 'workspace' as const };
const members = (...principalIds: string[]) => ({ kind: 'principals' as const, principalIds });
type ErrorBody = { error: string; code?: string };

async function start(basePath = '/') {
  const store = new Store({ path: ':memory:' });
  const provision = createAuth({ database: store.database, mode: 'local', basePath, provisioning: true });
  const password = 'Private review draft API fixture password';
  const alice = await provision.createAccount({ username: 'alice', displayName: 'Alice Author', password });
  const bob = await provision.createAccount({ username: 'bob', displayName: 'Bob Reviewer', password });
  const app = createApp({ store, seed: false, authMode: 'password', basePath });
  const tokens = {
    alice: app.auth.createToken(alice.id, { name: 'Author', scopes: ['read', 'write'] }),
    bob: app.auth.createToken(bob.id, { name: 'Reviewer', scopes: ['read', 'write'] }),
    reader: app.auth.createToken(bob.id, { name: 'Read only', scopes: ['read'] }),
  };
  const actor: ActorAttribution = { principalId: alice.id, displayName: alice.displayName, credentialId: tokens.alice.record.id, requestId: 'private-draft-fixture' };
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const raw = async <T = ErrorBody>(path: string, method = 'GET', value?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`${origin}${basePath.replace(/\/$/, '')}${path}`, {
      method, signal: AbortSignal.timeout(30_000), headers: { ...(value === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    });
    return { status: response.status, body: await response.json() as T, headers: response.headers };
  };
  const request = <T = ErrorBody>(path: string, method = 'GET', value?: unknown, who: keyof typeof tokens = 'bob', key?: string) => raw<T>(path, method, value, { Authorization: `Bearer ${tokens[who].token}`, ...(key ? { 'Idempotency-Key': key } : {}) });
  const policy = (id: string, rules: Record<string, unknown>) => {
    const current = app.policies.policy(id, alice.id);
    return app.policies.setPolicy(id, { expectedVersion: current.version, spaceId: current.spaceId, ...current.rules, ...rules }, alice.id);
  };
  const revision = () => {
    const detail = store.createRevision({ kind: 'paper', title: 'Private review target', testPlan: 'Inspect immutable source.', files: [{ path: 'paper.txt', content: 'First exact source line.\nSecond exact source line.\n' }] }, actor);
    policy(detail.revision.id, { view: workspace, edit: members(alice.id), interact: workspace });
    return detail;
  };
  const browser = async () => {
    const boot = await raw<SessionState>('/api/session');
    const challenge = boot.headers.getSetCookie().map(cookie => cookie.split(';')[0]!).join('; ');
    const login = await raw<SessionState>('/api/login', 'POST', { username: 'bob', password }, { Cookie: challenge, Origin: origin, 'X-CSRF-Token': boot.body.csrfToken! });
    assert.equal(login.status, 200);
    return { Cookie: login.headers.getSetCookie().map(cookie => cookie.split(';')[0]!).join('; '), Origin: origin, 'X-CSRF-Token': login.body.csrfToken!, 'X-Session-Context': login.body.sessionContext! };
  };
  const path = (id: string) => `/api/revisions/${id}/review-drafts`;
  const input = (id: string, body = 'An exact private observation.'): ReviewDraftSaveInput => {
    const detail = store.detail(id), version = detail.versions.find(v => v.number === detail.revision.currentVersion)!;
    return { expectedEntryVersion: 0, expectedAccessEpoch: app.policies.epoch(), payload: { kind: 'comment', body, versionId: version.id, contentHash: version.contentHash, filePath: 'paper.txt', line: 1 } };
  };
  const save = async (id: string, data = input(id), who: keyof typeof tokens = 'bob', entryId = randomUUID(), key = randomUUID()) => {
    const response = await request<ReviewDraftChangeReceipt>(`${path(id)}/${entryId}`, 'PUT', data, who, key);
    assert.equal(response.status, 200, JSON.stringify(response.body)); return { data, entryId, key, receipt: response.body };
  };
  return { ...app, alice, bob, actor, tokens, origin, request, raw, policy, revision, browser, path, input, save, close: async () => { await app.close(); store.close(); } };
}

for (const basePath of ['/', '/mounted/']) test(`private review drafts remain owner-only and have no public side effects at ${basePath}`, async () => {
  const app = await start(basePath);
  try {
    const id = app.revision().revision.id, before = app.store.detail(id), ai = { configured: false, model: null }, state = app.store.state(ai);
    const saved = await app.save(id, app.input(id, 'Unpublished private words for @alice.'));
    assert.equal(saved.receipt.principalId, app.bob.id);
    const own = await app.request<ReviewDraftSnapshot>(app.path(id));
    assert.equal(own.status, 200); assert.equal(own.headers.get('cache-control'), 'no-store');
    assert.equal(own.body.entries.length, 1); assert.equal(own.body.entries[0]!.id, saved.entryId);
    const other = await app.request<ReviewDraftSnapshot>(app.path(id), 'GET', undefined, 'alice');
    assert.equal(other.status, 200); assert.equal(other.body.principalId, app.alice.id); assert.deepEqual(other.body.entries, []); assert.equal(other.body.setVersion, 0);
    assert.deepEqual(app.store.detail(id), before);
    assert.deepEqual(app.store.state(ai), state, 'private saves never alter normal comments, activity, review evidence or public state');
    assert.equal(app.store.notifications.summary(app.alice.id, app.policies.epoch()).unreadCount, 0);
    assert.equal(app.store.revisionSubscriptions.effective(id, app.bob.id), false);
    for (const route of ['/api/state', `/api/revisions/${id}`, `/api/revisions/${id}/export`]) assert.doesNotMatch(JSON.stringify((await app.request(route, 'GET', undefined, 'alice')).body), /Unpublished private words/);
    const foreign = await app.request(`${app.path(id)}/${saved.entryId}/discard`, 'POST', { expectedEntryVersion: 1, expectedAccessEpoch: app.policies.epoch() }, 'alice', randomUUID());
    const missing = await app.request(`${app.path(id)}/${randomUUID()}/discard`, 'POST', { expectedEntryVersion: 1, expectedAccessEpoch: app.policies.epoch() }, 'alice', randomUUID());
    assert.equal(foreign.status, 404); assert.deepEqual(foreign.body, missing.body);
    assert.equal((await app.request(`${app.path(id)}/${saved.entryId}`, 'PUT', app.input(id), 'alice', randomUUID())).status, 404);
  } finally { await app.close(); }
});

test('private draft discovery filters permission before page slots and counts, and rejects owner selection', async () => {
  const app = await start();
  try {
    const ids = [app.revision(), app.revision(), app.revision()].map(d => d.revision.id);
    for (const id of ids) await app.save(id);
    await app.save(ids[0]!, app.input(ids[0]!, 'Other account private text.'), 'alice');
    app.policy(ids[0]!, { view: members(app.alice.id) });
    const first = await app.request<ReviewDraftDiscovery>('/api/review-drafts?limit=1');
    assert.equal(first.status, 200); assert.equal(first.body.principalId, app.bob.id); assert.deepEqual(first.body.items.map(v => v.revisionId), [ids[1]]); assert.equal(first.body.items[0]!.entryCount, 1); assert.equal(first.body.nextAfter, ids[1]);
    const next = await app.request<ReviewDraftDiscovery>(`/api/review-drafts?limit=1&after=${first.body.nextAfter}`);
    assert.deepEqual(next.body.items.map(v => v.revisionId), [ids[2]]); assert.equal(next.body.nextAfter, null);
    for (const query of ['?principalId=' + app.alice.id, '?limit=101', '?limit=0', '?limit=1&limit=2', '?after=invalid', '?after=']) assert.equal((await app.request('/api/review-drafts' + query)).status, 400);
    assert.equal((await app.request(app.path(ids[1]!) + '?principalId=' + app.alice.id)).status, 400);
    const hidden = await app.request(app.path(ids[0]!)), missing = await app.request(app.path('P999999'));
    assert.equal(hidden.status, 404); assert.deepEqual(hidden.body, missing.body);
  } finally { await app.close(); }
});

test('save, discard and publication have exact immutable retries after later set and source changes', async () => {
  const app = await start();
  try {
    const id = app.revision().revision.id, one = await app.save(id);
    const edit = await app.save(id, { ...one.data, expectedEntryVersion: 1, payload: { ...one.data.payload, body: 'Revised private observation.' } }, 'bob', one.entryId);
    assert.deepEqual((await app.request(`${app.path(id)}/${one.entryId}`, 'PUT', one.data, 'bob', one.key)).body, one.receipt);
    const second = await app.save(id, app.input(id, 'Second private observation.'));
    const preview = await app.request<ReviewDraftPreview>(app.path(id) + '/preview'); assert.equal(preview.status, 200);
    const beforeVersions = app.store.detail(id).versions, publishKey = randomUUID(), publication = await app.request<ReviewDraftPublicationReceipt>(app.path(id) + '/publish', 'POST', { manifest: preview.body.manifest }, 'bob', publishKey);
    assert.equal(publication.status, 200, JSON.stringify(publication.body)); assert.equal(publication.body.published.length, 2);
    assert.deepEqual(publication.body.published.map(v => v.draftId).sort(), [edit.entryId, second.entryId].sort());
    assert.ok(publication.body.published.every(v => v.comment.attribution?.principalId === app.bob.id));
    assert.deepEqual(app.store.detail(id).versions, beforeVersions); assert.equal(app.store.detail(id).comments.length, 2);
    assert.deepEqual((await app.request<ReviewDraftSnapshot>(app.path(id))).body.entries, []);
    app.store.createVersion(id, { expectedVersion: 1, message: 'A later head', files: [{ path: 'paper.txt', content: 'A later immutable source.\n' }] }, app.actor);
    const later = await app.save(id, app.input(id, 'A newer batch stays private.'));
    const replay = await app.request<ReviewDraftPublicationReceipt>(app.path(id) + '/publish', 'POST', { manifest: preview.body.manifest }, 'bob', publishKey);
    assert.equal(replay.status, 200); assert.deepEqual(replay.body, publication.body); assert.equal(app.store.detail(id).comments.length, 2);
    assert.deepEqual((await app.request<ReviewDraftSnapshot>(app.path(id))).body.entries.map(v => v.id), [later.entryId]);
    const discard = { expectedEntryVersion: 1, expectedAccessEpoch: app.policies.epoch() }, discardKey = randomUUID();
    const discarded = await app.request(`${app.path(id)}/${later.entryId}/discard`, 'POST', discard, 'bob', discardKey); assert.equal(discarded.status, 200);
    await app.save(id);
    assert.deepEqual((await app.request(`${app.path(id)}/${later.entryId}/discard`, 'POST', discard, 'bob', discardKey)).body, discarded.body);
    assert.equal((await app.request(`${app.path(id)}/${later.entryId}`, 'PUT', { ...later.data, expectedEntryVersion: 2 }, 'bob', randomUUID())).status, 409, 'discarded identities cannot be resurrected');
  } finally { await app.close(); }
});

test('private draft writes require scoped credentials, CSRF and Interact; View remains sufficient to inspect or discard', async () => {
  const app = await start();
  try {
    const id = app.revision().revision.id, entryId = randomUUID(), input = app.input(id), route = `${app.path(id)}/${entryId}`;
    assert.equal((await app.raw(app.path(id))).status, 401);
    assert.equal((await app.request(route, 'PUT', input, 'reader', randomUUID())).status, 403);
    assert.equal((await app.request(route, 'PUT', input)).status, 400);
    const browser = await app.browser();
    assert.equal((await app.raw(route, 'PUT', input, { ...browser, 'X-CSRF-Token': '', 'Idempotency-Key': randomUUID() })).status, 403);
    assert.equal((await app.raw(route, 'PUT', input, { ...browser, Origin: 'https://attacker.example', 'Idempotency-Key': randomUUID() })).status, 403);
    const saved = await app.save(id, input, 'bob', entryId), preview = (await app.request<ReviewDraftPreview>(app.path(id) + '/preview')).body;
    app.policy(id, { interact: members(app.alice.id) });
    assert.equal((await app.request(route, 'PUT', input, 'bob', saved.key)).status, 403, 'save retries require current Interact');
    assert.equal((await app.request(app.path(id) + '/publish', 'POST', { manifest: preview.manifest }, 'bob', randomUUID())).status, 403);
    assert.equal((await app.request(app.path(id), 'GET', undefined, 'reader')).status, 200);
    assert.equal((await app.request(app.path(id) + '/preview', 'GET', undefined, 'reader')).status, 200);
    const discard = { expectedEntryVersion: 1, expectedAccessEpoch: app.policies.epoch() }, key = randomUUID();
    assert.equal((await app.request(route + '/discard', 'POST', discard, 'bob', key)).status, 200);
    app.policy(id, { view: members(app.alice.id) });
    assert.equal((await app.request(route + '/discard', 'POST', discard, 'bob', key)).status, 404);
    assert.equal((await app.request(app.path(id))).status, 404);
    app.auth.revokeToken(app.bob.id, app.tokens.bob.record.id);
    assert.equal((await app.request('/api/review-drafts')).status, 401);
  } finally { await app.close(); }
});

test('strict private draft inputs and stale publication previews fail without partial effects', async () => {
  const app = await start();
  try {
    const id = app.revision().revision.id, input = app.input(id), entryId = randomUUID(), route = `${app.path(id)}/${entryId}`;
    for (const patch of [{ principalId: app.alice.id }, { expectedEntryVersion: -1 }, { expectedAccessEpoch: '1' }, { payload: { ...input.payload, body: '' } }, { payload: { ...input.payload, body: 'x'.repeat(20001) } }, { payload: { ...input.payload, body: '\ud800' } }, { payload: { ...input.payload, ownerId: app.alice.id } }]) assert.equal((await app.request(route, 'PUT', { ...input, ...patch }, 'bob', randomUUID())).status, 400);
    const saved = await app.save(id, input, 'bob', entryId), preview = (await app.request<ReviewDraftPreview>(app.path(id) + '/preview')).body;
    await app.save(id, { ...input, expectedEntryVersion: 1, payload: { ...input.payload, body: 'Changed after preview.' } }, 'bob', saved.entryId);
    const rejected = await app.request(app.path(id) + '/publish', 'POST', { manifest: preview.manifest }, 'bob', randomUUID()); assert.equal(rejected.status, 409); assert.equal(app.store.detail(id).comments.length, 0);
    assert.equal((await app.request(app.path(id) + '/publish', 'POST', { manifest: preview.manifest, body: 'Unreviewed summary' }, 'bob', randomUUID())).status, 400);
    assert.equal((await app.request(route, 'PUT', { ...input, expectedEntryVersion: 1 }, 'bob', saved.key)).status, 409);
    assert.equal((await app.request(app.path(id) + '/preview?principalId=' + app.alice.id)).status, 400);
  } finally { await app.close(); }
});

test('private receipts reject foreign operations and same-owner cross-key substitutions before exposing content', async () => {
  const app = await start();
  try {
    const id = app.revision().revision.id, saved = await app.save(id), other = await app.save(id, app.input(id, 'Other private draft.'));
    const foreign = await app.save(id, app.input(id, 'Alice only private draft.'), 'alice');
    const row = app.store.database.prepare('SELECT key,body FROM idempotency WHERE key LIKE ?').get(`%:${saved.key}`) as { key: string; body: string };
    const operation = app.store.reviewDrafts.operation.bind(app.store.reviewDrafts); let foreignLoads = 0;
    app.store.reviewDrafts.operation = operationId => { if (operationId === foreign.receipt.operationId) { foreignLoads++; throw new Error('Foreign operation contents loaded'); } return operation(operationId); };
    for (const receipt of [other.receipt, foreign.receipt, { ...saved.receipt, operationId: foreign.receipt.operationId }, { ...saved.receipt, inputSha256: 'f'.repeat(64) }, { ...saved.receipt, entry: { ...saved.receipt.entry, payload: { ...saved.receipt.entry.payload, body: 'Forged contents' } } }]) {
      app.store.database.prepare('UPDATE idempotency SET body=? WHERE key=?').run(JSON.stringify(receipt), row.key);
      const response = await app.request(`${app.path(id)}/${saved.entryId}`, 'PUT', saved.data, 'bob', saved.key);
      assert.equal(response.status, 409); assert.equal(response.body.code, 'REVIEW_DRAFT_INVALID_RECEIPT'); assert.doesNotMatch(JSON.stringify(response.body), /Alice only|Other private|Forged contents/);
      assert.equal((app.store.database.prepare('SELECT body FROM idempotency WHERE key=?').get(row.key) as { body: string }).body, JSON.stringify(receipt), 'rejected evidence is preserved');
    }
    assert.equal(foreignLoads, 0);
    app.store.database.prepare('UPDATE idempotency SET body=? WHERE key=?').run(row.body, row.key);
    assert.equal((await app.request(`${app.path(id)}/${saved.entryId}`, 'PUT', saved.data, 'bob', saved.key)).status, 200);
  } finally { await app.close(); }
});

test('publication maps root, summary and reply drafts once and rejects corrupted saved mappings', async () => {
  const app = await start();
  try {
    const detail = app.revision(), id = detail.revision.id, version = detail.versions[0]!;
    const root = app.store.createComment(id, { body: 'An existing public discussion.', versionId: version.id }, app.actor);
    await app.save(id, app.input(id, 'A staged root with @alice.'));
    await app.save(id, { expectedEntryVersion: 0, expectedAccessEpoch: app.policies.epoch(), payload: { kind: 'summary', body: 'Overall private review summary.', versionId: version.id, contentHash: version.contentHash } });
    await app.save(id, { expectedEntryVersion: 0, expectedAccessEpoch: app.policies.epoch(), payload: { kind: 'reply', body: 'A staged reply.', threadId: root.threadId!, viewedVersionId: version.id, viewedContentHash: version.contentHash } });
    const preview = (await app.request<ReviewDraftPreview>(app.path(id) + '/preview')).body, input = { manifest: preview.manifest }, key = randomUUID();
    assert.equal(preview.manifest.threads.length, 1);
    const published = await app.request<ReviewDraftPublicationReceipt>(app.path(id) + '/publish', 'POST', input, 'bob', key);
    assert.equal(published.status, 200, JSON.stringify(published.body)); assert.equal(published.body.published.length, 3);
    const reply = published.body.published.find(item => item.comment.body === 'A staged reply.')!;
    assert.equal(reply.comment.threadId, root.threadId); assert.equal(reply.comment.viewedVersionId, version.id);
    const row = app.store.database.prepare('SELECT key,body FROM idempotency WHERE key LIKE ?').get(`%:${key}`) as { key: string; body: string };
    for (const corrupt of [
      { ...published.body, published: [...published.body.published].reverse() },
      { ...published.body, published: published.body.published.map((item, index) => index ? item : { ...item, comment: { ...item.comment, body: 'Forged comment body.' } }) },
      { ...published.body, setVersion: published.body.setVersion + 1 },
    ]) {
      app.store.database.prepare('UPDATE idempotency SET body=? WHERE key=?').run(JSON.stringify(corrupt), row.key);
      const rejected = await app.request(app.path(id) + '/publish', 'POST', input, 'bob', key);
      assert.equal(rejected.status, 409); assert.equal(rejected.body.code, 'REVIEW_DRAFT_INVALID_RECEIPT'); assert.equal(app.store.detail(id).comments.length, 4);
    }
    app.store.database.prepare('UPDATE idempotency SET body=? WHERE key=?').run(row.body, row.key);
    const retry = await app.request<ReviewDraftPublicationReceipt>(app.path(id) + '/publish', 'POST', input, 'bob', key);
    assert.equal(retry.status, 200); assert.deepEqual(retry.body, published.body); assert.equal(app.store.detail(id).comments.length, 4);
    app.policy(id, { interact: members(app.alice.id) });
    assert.equal((await app.request(app.path(id) + '/publish', 'POST', input, 'bob', key)).status, 403);
  } finally { await app.close(); }
});

test('private discovery, source reads and exact retries honor repository visibility dependencies', async () => {
  const app = await start();
  try {
    const repository = app.store.createRepository({ name: 'Repository visibility ceiling', remoteUrl: 'https://example.test/source.git', defaultBranch: 'main' }, app.actor);
    const detail = app.store.createRevision({ title: 'Repository-backed private draft', testPlan: 'Inspect the exact file.', kind: 'code', repositoryId: repository.id, files: [{ path: 'paper.txt', content: 'Source tied to repository access.' }] }, app.actor), id = detail.revision.id;
    app.policy(id, { view: workspace, interact: workspace, edit: members(app.alice.id) });
    const saved = await app.save(id);
    assert.equal((await app.request<ReviewDraftDiscovery>('/api/review-drafts')).body.items.length, 1);
    app.policy(repository.id, { view: members(app.alice.id) });
    assert.deepEqual((await app.request<ReviewDraftDiscovery>('/api/review-drafts')).body.items, []);
    assert.equal((await app.request(app.path(id))).status, 404);
    assert.equal((await app.request(app.path(id) + '/preview')).status, 404);
    assert.equal((await app.request(`${app.path(id)}/${saved.entryId}`, 'PUT', saved.data, 'bob', saved.key)).status, 404);
    app.policy(repository.id, { view: workspace });
    assert.equal((await app.request<ReviewDraftSnapshot>(app.path(id))).body.entries[0]!.payload.body, saved.data.payload.body, 'visibility filtering preserves the private draft');
  } finally { await app.close(); }
});

test('historical replies pin both original and inspected source and never relocate on publication', async () => {
  const app = await start();
  try {
    const detail = app.revision(), id = detail.revision.id, original = detail.versions[0]!;
    const root = app.store.createComment(id, { body: 'Original source discussion.', versionId: original.id, filePath: 'paper.txt', line: 2 }, app.actor);
    const newer = app.store.createVersion(id, { expectedVersion: 1, message: 'New source for inspection', files: [{ path: 'paper.txt', content: 'A different inspected source.\n' }] }, app.actor).versions.find(v => v.number === 2)!;
    const saved = await app.save(id, { expectedEntryVersion: 0, expectedAccessEpoch: app.policies.epoch(), payload: { kind: 'reply', body: 'Reply while reading version two.', threadId: root.threadId!, viewedVersionId: newer.id, viewedContentHash: newer.contentHash } });
    const preview = (await app.request<ReviewDraftPreview>(app.path(id) + '/preview')).body;
    assert.deepEqual(preview.manifest.sources.map(v => v.versionId).sort(), [original.id, newer.id].sort());
    const omitted = { manifest: { ...preview.manifest, sources: preview.manifest.sources.filter(v => v.versionId !== original.id) } };
    assert.equal((await app.request(app.path(id) + '/publish', 'POST', omitted, 'bob', randomUUID())).status, 409);
    assert.equal(app.store.detail(id).comments.length, 1);
    const response = await app.request<ReviewDraftPublicationReceipt>(app.path(id) + '/publish', 'POST', { manifest: preview.manifest }, 'bob', randomUUID());
    assert.equal(response.status, 200); const comment = response.body.published[0]!.comment;
    assert.equal(response.body.published[0]!.draftId, saved.entryId); assert.equal(comment.versionId, original.id); assert.equal(comment.viewedVersionId, newer.id); assert.equal(comment.line, 2); assert.equal(comment.filePath, 'paper.txt');
  } finally { await app.close(); }
});

test('failure of the API immutable presenter rolls the entire publication back before acknowledgment', async () => {
  const app = await start();
  try {
    const id = app.revision().revision.id; await app.save(id, app.input(id, 'First atomic observation for @alice.')); await app.save(id, app.input(id, 'Second atomic observation.'));
    const preview = (await app.request<ReviewDraftPreview>(app.path(id) + '/preview')).body, input = { manifest: preview.manifest }, key = randomUUID();
    const notificationRows = () => Object.fromEntries(['notification_events', 'notification_deliveries', 'notification_read_state'].map(table => [table, app.store.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
    const publicBefore = app.store.detail(id), privateBefore = app.store.reviewDrafts.snapshot(id, app.bob.id), notificationsBefore = notificationRows();
    const counts = () => Object.fromEntries(['review_draft_operations', 'idempotency', 'activity'].map(table => [table, (app.store.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count]));
    const beforeCounts = counts(), original = app.store.reviewDrafts.operation.bind(app.store.reviewDrafts);
    app.store.reviewDrafts.operation = operationId => { const operation = original(operationId); if (operation.kind === 'publish') throw new Error('Injected presenter verification failure'); return operation; };
    const rejected = await app.request(app.path(id) + '/publish', 'POST', input, 'bob', key);
    assert.equal(rejected.status, 409); assert.equal(rejected.body.code, 'REVIEW_DRAFT_INVALID_RECEIPT');
    assert.deepEqual(app.store.detail(id), publicBefore); assert.deepEqual(app.store.reviewDrafts.snapshot(id, app.bob.id), privateBefore); assert.deepEqual(counts(), beforeCounts); assert.deepEqual(notificationRows(), notificationsBefore);
    app.store.reviewDrafts.operation = original;
    const retry = await app.request<ReviewDraftPublicationReceipt>(app.path(id) + '/publish', 'POST', input, 'bob', key);
    assert.equal(retry.status, 200); assert.equal(retry.body.published.length, 2); assert.equal(app.store.detail(id).comments.length, 2);
  } finally { await app.close(); }
});
