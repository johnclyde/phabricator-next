import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Worker } from 'node:worker_threads';
import type { AddressInfo } from 'node:net';
import { createApp } from './app.ts';
import { createAuth } from './auth.ts';
import { Store } from './store.ts';
import type { ActorAttribution, RevisionDetail, ReviewComment } from '../shared/types.ts';
import type { SessionState } from '../shared/auth.ts';
import type { FileRecord } from '../shared/files.ts';
import type { NotificationInbox, NotificationSummary, NotificationItem, NotificationReceipt, NotificationReadInput } from '../shared/notifications.ts';
import type { RevisionSubscriptionSnapshot } from '../shared/revision-subscriptions.ts';
import { lifecycleInput } from '../tests/revision-lifecycle-fixture.ts';

const workspace = { kind: 'workspace' as const }, members = (...principalIds: string[]) => ({ kind: 'principals' as const, principalIds });
type ErrorBody = { error: string; code?: string };
async function start(basePath = '/', databasePath = ':memory:') {
  const store = new Store({ path: databasePath }), provision = createAuth({ database: store.database, mode: 'local', basePath, provisioning: true });
  const alice = await provision.createAccount({ username: 'alice', displayName: 'Alice Author', password: 'Alice notification account password' });
  const bob = await provision.createAccount({ username: 'bob', displayName: 'Bob Reader', password: 'Bob notification account password' });
  const carol = await provision.createAccount({ username: 'carol', displayName: 'Carol Reader', password: 'Carol notification account password' });
  const app = createApp({ store, seed: false, authMode: 'password', basePath });
  const tokens = { alice: app.auth.createToken(alice.id, { name: 'Author', scopes: ['read', 'write'] }), bob: app.auth.createToken(bob.id, { name: 'Reader writes preferences', scopes: ['read', 'write'] }), carol: app.auth.createToken(carol.id, { name: 'Independent reader', scopes: ['read', 'write'] }), reader: app.auth.createToken(bob.id, { name: 'Read only', scopes: ['read'] }) };
  const actor: ActorAttribution = { principalId: alice.id, displayName: alice.displayName, credentialId: tokens.alice.record.id, requestId: 'notification-fixture' };
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}${basePath.replace(/\/$/, '')}`;
  async function request<T = ErrorBody>(path: string, method = 'GET', body?: unknown, who: keyof typeof tokens = 'bob', key?: string) {
    const response = await fetch(origin + path, { method, signal: AbortSignal.timeout(30_000), headers: { Authorization: `Bearer ${tokens[who].token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as T, headers: response.headers };
  }
  const policy = (id: string, rules: Record<string, unknown>) => { const p = app.policies.policy(id, alice.id); return app.policies.setPolicy(id, { expectedVersion: p.version, spaceId: p.spaceId, ...p.rules, ...rules }, alice.id); };
  const revision = (extra = {}) => { const detail = store.createRevision({ kind: 'paper', title: 'Notification source', testPlan: 'Inspect changes.', files: [{ path: 'paper.txt', content: 'Private source must never be copied into an inbox.' }], ...extra }, actor); policy(detail.revision.id, { view: workspace, edit: members(alice.id), interact: workspace }); return detail; };
  const inbox = async (who: keyof typeof tokens = 'bob', query = '') => { const result = await request<NotificationInbox>(`/api/notifications${query}`, 'GET', undefined, who); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body; };
  const summary = async (who: keyof typeof tokens = 'bob') => { const result = await request<NotificationSummary>('/api/notifications/count', 'GET', undefined, who); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body; };
  const follow = async (id: string, who: 'bob' | 'carol' = 'bob', action: 'subscribe' | 'unsubscribe' | 'mute' | 'unmute' = 'subscribe') => { const snap = await request<RevisionSubscriptionSnapshot>(`/api/revisions/${id}/subscriptions`, 'GET', undefined, who); assert.equal(snap.status, 200); const s = snap.body, input = { action, principalId: s.viewer.principalId, expectedAuthorVersion: s.authorVersion, expectedReviewerVersion: s.reviewerVersion, expectedAccessEpoch: s.accessEpoch, ...(action === 'subscribe' || action === 'unsubscribe' ? { expectedSubscriptionVersion: s.viewer.version } : { expectedMuteVersion: s.mute.version }) }; const result = await request(`/api/revisions/${id}/subscriptions`, 'POST', input, who, randomUUID()); assert.equal(result.status, 200, JSON.stringify(result.body)); };
  const comment = async (id: string, key: string = randomUUID(), who: 'alice' | 'bob' | 'carol' = 'alice') => { const version = store.detail(id).versions.find(v => v.number === store.detail(id).revision.currentVersion)!; const result = await request<ReviewComment>(`/api/revisions/${id}/comments`, 'POST', { versionId: version.id, body: 'Private comment body is not notification content.' }, who, key); assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body; };
  const mark = (item: NotificationItem, action: 'read' | 'unread' = 'read'): NotificationReadInput => ({ action, notificationId: item.id, expectedVersion: item.version, expectedAccessEpoch: app.policies.epoch() });
  return { ...app, alice, bob, carol, actor, tokens, origin, request, policy, revision, inbox, summary, follow, comment, mark, close: async () => { await app.close(); store.close(); } };
}

for (const basePath of ['/', '/mounted/']) test(`notification API isolates personal read state and exact retries at ${basePath}`, async () => {
  const app = await start(basePath);
  try {
    const detail = app.revision(), id = detail.revision.id; await app.follow(id); await app.follow(id, 'carol');
    assert.equal((await app.summary()).unreadCount, 0, 'self subscription is silent');
    const comment = await app.comment(id, 'one-comment'); await app.comment(id, 'one-comment');
    const page = await app.inbox('reader'), other = await app.inbox('carol'); assert.equal(page.items.length, 1); assert.equal(page.unreadCount, 1); assert.equal((await app.summary('alice')).unreadCount, 0, 'actor is not notified');
    const item = page.items[0]!; assert.equal(item.event.kind, 'commented'); assert.equal(item.event.objectId, id); assert.equal(item.event.actor?.principalId, app.alice.id); assert.equal((item.event.context.kind === 'revision' ? item.event.context.head?.versionId : undefined), comment.versionId); assert.equal(item.version, 0); assert.equal(item.read, false);
    assert.equal(other.items[0]!.event.id, item.event.id); assert.notEqual(other.items[0]!.id, item.id);
    const wire = JSON.stringify(page); assert.doesNotMatch(wire, /Private source|Private comment|credentialId|requestId/);
    const response = await app.request('/api/notifications'); assert.equal(response.headers.get('cache-control'), 'no-store');
    const input = app.mark(item); assert.equal((await app.request('/api/notifications/read', 'POST', input, 'reader', 'readonly-mark')).status, 403);
    const foreign = await app.request('/api/notifications/read', 'POST', app.mark(other.items[0]!), 'bob', 'foreign-mark'), missing = await app.request('/api/notifications/read', 'POST', { ...input, notificationId: randomUUID() }, 'bob', 'missing-mark'); assert.equal(foreign.status, 404); assert.deepEqual(foreign.body, missing.body);
    const saved = await app.request<NotificationReceipt>('/api/notifications/read', 'POST', input, 'bob', 'mark-exact'); assert.equal(saved.status, 200); assert.equal(saved.body.changed, true); assert.deepEqual(Object.keys(saved.body).sort(), ['accessEpoch', 'changed', 'inputSha256', 'operationId']);
    assert.equal((await app.summary()).unreadCount, 0); assert.equal((await app.summary('carol')).unreadCount, 1); assert.equal((await app.inbox('bob', '?filter=read')).items.length, 1);
    assert.equal((await app.request('/api/notifications/read', 'POST', input, 'bob', 'stale-mark')).status, 409);
    const readItem = (await app.inbox()).items[0]!; const unread = await app.request('/api/notifications/read', 'POST', app.mark(readItem, 'unread'), 'bob', 'make-unread'); assert.equal(unread.status, 200);
    const retry = await app.request('/api/notifications/read', 'POST', input, 'bob', 'mark-exact'); assert.equal(retry.status, 200); assert.deepEqual(retry.body, saved.body); assert.equal((await app.summary()).unreadCount, 1, 'historical retry must not repeat a read effect');
    assert.equal(app.policies.access(id, app.bob.id).edit, false, 'personal marking did not require editing the revision');
  } finally { await app.close(); }
});

test('notification cursors bind owner, filter, epoch and read state while horizons exclude later arrivals', async () => {
  const app = await start();
  try {
    const id = app.revision().revision.id; await app.follow(id); await app.follow(id, 'carol');
    for (let i = 0; i < 3; i++) await app.comment(id);
    const first = await app.inbox('bob', '?filter=unread&limit=1'); assert.ok(first.nextBefore); assert.equal(first.unreadCount, 3);
    await app.comment(id); const newest = (await app.inbox()).items[0]!;
    const next = await app.inbox('bob', `?filter=unread&limit=100&before=${first.nextBefore}`); assert.equal(next.items.length, 2); assert.equal(next.items.some(item => item.id === newest.id), false);
    for (const [who, filter, status, code] of [['carol', 'unread', 400, 'NOTIFICATION_CURSOR_INVALID'], ['bob', 'all', 409, 'NOTIFICATION_CHANGED']] as const) { const denied: { status: number; body: ErrorBody } = await app.request(`/api/notifications?filter=${filter}&before=${first.nextBefore}`, 'GET', undefined, who); assert.equal(denied.status, status); assert.equal(denied.body.code, code); }
    const input: NotificationReadInput = { action: 'read_through', horizon: first.horizon, expectedAccessEpoch: first.accessEpoch };
    assert.equal((await app.request('/api/notifications/read', 'POST', input, 'bob', 'observed-read-through')).status, 200);
    const remaining = await app.inbox('bob', '?filter=unread'); assert.deepEqual(remaining.items.map(item => item.id), [newest.id]); assert.equal(remaining.unreadCount, 1);
    assert.equal((await app.request(`/api/notifications?filter=unread&before=${first.nextBefore}`)).status, 409);
    assert.equal((await app.request('/api/notifications/read', 'POST', input, 'bob', 'observed-read-through')).status, 200); assert.equal((await app.summary()).unreadCount, 1);
    const secondId = app.revision().revision.id; await app.follow(secondId); await app.comment(secondId);
    const summary = await app.summary(), objectRead = { action: 'read_object', revisionId: id, horizon: summary.horizon, expectedAccessEpoch: summary.accessEpoch };
    assert.equal((await app.request('/api/notifications/read', 'POST', objectRead, 'bob', 'object-view')).status, 200);
    assert.deepEqual((await app.inbox('bob', '?filter=unread')).items.map(item => item.event.objectId), [secondId]);
    const oldCursor = (await app.inbox('bob', '?limit=1')).nextBefore!; app.policy(id, { interact: members(app.alice.id) });
    assert.equal((await app.request(`/api/notifications?before=${oldCursor}`)).status, 409);
    for (const suffix of ['?unknown=1', '?limit=1&limit=2', '?limit=101', '?limit=0', '?filter=unknown', '?before=', '/count?limit=1']) assert.equal((await app.request(`/api/notifications${suffix}`)).status, 400, suffix);
    assert.equal((await app.request('/api/notifications/read', 'POST', { ...objectRead, extra: true }, 'bob', 'extra')).status, 400);
  } finally { await app.close(); }
});

test('inbox rows and counts follow current revision, repository, historical File and Space policies without granting access', async () => {
  const app = await start();
  try {
    const repository = app.store.createRepository({ name: 'Private source repository', remoteUrl: 'https://example.test/private.git', defaultBranch: 'main' }, app.actor);
    const paper = app.revision({ repositoryId: repository.id }).revision.id; await app.follow(paper); await app.comment(paper);
    const item = (await app.inbox()).items[0]!, input = app.mark(item), saved = await app.request('/api/notifications/read', 'POST', input, 'bob', 'later-revoked'); assert.equal(saved.status, 200);
    await app.comment(paper); app.policy(repository.id, { view: members(app.alice.id) });
    assert.equal((await app.inbox()).items.length, 0); assert.equal((await app.summary()).unreadCount, 0);
    assert.equal((await app.request('/api/notifications/read', 'POST', input, 'bob', 'later-revoked')).status, 404);
    const current = await app.summary(); assert.equal((await app.request('/api/notifications/read', 'POST', { action: 'read_object', revisionId: paper, horizon: current.horizon, expectedAccessEpoch: current.accessEpoch }, 'bob', 'hidden-object')).status, 404);
    app.policy(repository.id, { view: workspace }); assert.equal((await app.summary()).unreadCount, 1, 'filtering inaccessible deliveries did not secretly mark them read');
    const bytes = await readFile(new URL('../tests/fixtures/docx/roundtrip.docx', import.meta.url));
    const upload = await app.request<FileRecord>('/api/files', 'POST', { name: 'Word notification source', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), dataBase64: bytes.toString('base64') }, 'alice', 'word-file'); assert.equal(upload.status, 201);
    const file = upload.body, imported = await app.request<RevisionDetail>('/api/revisions/docx', 'POST', { title: 'Word notification', testPlan: 'Read pages.', sourceFile: { fileId: file.id, sha256: file.sha256, bytes: file.bytes }, shareSource: true, expectedAccessEpoch: app.policies.epoch() }, 'alice', 'word-import'); assert.equal(imported.status, 201);
    const word = imported.body.revision.id; await app.follow(word); await app.comment(word); assert.equal((await app.inbox()).items.find(row => row.event.objectId === word)?.object.kind, 'document');
    const space = app.policies.createSpace({ name: 'Private File ceiling', view: members(app.alice.id), edit: members(app.alice.id) }, app.alice.id); app.policy(file.id, { spaceId: space.id });
    assert.equal((await app.inbox()).items.some(row => row.event.objectId === word), false); assert.equal((await app.summary()).unreadCount, 1);
    app.policy(paper, { spaceId: space.id }); assert.equal((await app.summary()).unreadCount, 0);
  } finally { await app.close(); }
});

test('notification generation honors mute, draft review-start and silent self-follow without replay fanout', async () => {
  const app = await start();
  try {
    const id = app.revision({ draft: true }).revision.id; await app.follow(id); await app.comment(id); assert.equal((await app.summary()).unreadCount, 0, 'draft activity is gated until review starts');
    const startInput = lifecycleInput(app.store, id, 'request_review'); assert.equal((await app.request(`/api/revisions/${id}/lifecycle`, 'POST', startInput, 'alice', 'start-review')).status, 200);
    const initial = (await app.summary()).unreadCount; assert.equal(initial, 1);
    await app.follow(id, 'bob', 'mute'); await app.comment(id); assert.equal((await app.summary()).unreadCount, initial);
    await app.follow(id, 'bob', 'unmute'); await app.comment(id, 'after-unmute'); await app.comment(id, 'after-unmute'); assert.equal((await app.summary()).unreadCount, initial + 1);
    await app.follow(id, 'bob', 'unsubscribe'); await app.comment(id); assert.equal((await app.summary()).unreadCount, initial + 1);
    assert.equal((await app.summary('alice')).unreadCount, 0);
  } finally { await app.close(); }
});

test('delivery uses final creation policies and failed saves leave no event, delivery or receipt', async () => {
  const app = await start();
  try {
    const project = app.store.createProject({ name: 'Watched project' }, app.actor);
    const watched = await app.request(`/api/projects/${project.id}/watchers`, 'POST', { principalId: app.bob.id, action: 'watch', expectedVersion: 0 }, 'bob', 'watch-project'); assert.equal(watched.status, 200);
    const create = { kind: 'paper', title: 'Private at creation', testPlan: 'Read source.', files: [{ path: 'private.txt', content: 'Not public at creation.' }], projectIds: [project.id], access: { spaceId: 'S1', view: members(app.alice.id), edit: members(app.alice.id), interact: members(app.alice.id) } };
    const result = await app.request<RevisionDetail>('/api/revisions', 'POST', create, 'alice', 'private-at-creation'); assert.equal(result.status, 201, JSON.stringify(result.body));
    const id = result.body.revision.id; assert.equal((await app.summary()).unreadCount, 0);
    app.policy(id, { view: workspace }); assert.equal((await app.inbox()).items.length, 0, 'later visibility cannot reveal a notification delivered under the temporary default creation policy');
    assert.equal(app.store.database.prepare('SELECT 1 FROM notification_deliveries d JOIN notification_events e ON e.id=d.event_id WHERE d.principal_id=? AND e.revision_id=?').get(app.bob.id, id), undefined);
    const tables = ['notification_events', 'notification_deliveries', 'notification_read_state', 'notification_operations', 'notification_read_changes'];
    const snapshot = () => Object.fromEntries(tables.map(table => [table, app.store.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
    const before = snapshot(), comments = app.store.detail(id).comments;
    app.store.database.exec("CREATE TEMP TRIGGER reject_notification_receipt BEFORE INSERT ON idempotency WHEN NEW.key LIKE '%:failed-notification-save' BEGIN SELECT RAISE(ABORT,'Injected receipt failure'); END");
    const failed = await app.request(`/api/revisions/${id}/comments`, 'POST', { versionId: result.body.versions[0]!.id, body: 'Atomic notification test' }, 'alice', 'failed-notification-save'); assert.equal(failed.status, 500);
    app.store.database.exec('DROP TRIGGER reject_notification_receipt');
    assert.deepEqual(snapshot(), before); assert.deepEqual(app.store.detail(id).comments, comments); assert.equal(app.store.database.prepare('SELECT 1 FROM idempotency WHERE key LIKE ?').get('%:failed-notification-save'), undefined);
    await app.comment(id); assert.equal((await app.summary()).unreadCount, 1, 'current project watchers receive later authorized activity');
  } finally { await app.close(); }
});

test('revision API workflows publish one logical notification and exact retries do not duplicate cascades', async () => {
  const app = await start();
  try {
    const id = app.revision().revision.id; await app.follow(id);
    const action = async (kind: NotificationItem['event']['kind'], suffix: string, input: unknown) => {
      const before = (await app.summary()).unreadCount, key = randomUUID(), path = `/api/revisions/${id}/${suffix}`;
      const saved = await app.request(path, 'POST', input, 'alice', key); assert.ok(saved.status === 200 || saved.status === 201, JSON.stringify(saved.body));
      const after = await app.inbox(); assert.equal(after.unreadCount, before + 1, suffix); assert.equal(after.items[0]!.event.kind, kind, suffix);
      assert.equal((await app.request(path, 'POST', input, 'alice', key)).status, saved.status); assert.equal((await app.summary()).unreadCount, before + 1, `${suffix} retry`);
    };
    await action('source_updated', 'versions', { expectedVersion: 1, message: 'Next source', files: [{ path: 'paper.txt', content: 'Updated source.' }] });
    const metadata = app.store.revisionMetadata.snapshot(id);
    const metadataInput = { title: 'Renamed revision', summary: 'New summary', testPlan: 'Inspect source.', message: 'Clarify metadata', expectedMetadataVersion: metadata.metadata.version, expectedVersion: metadata.head.number, expectedVersionId: metadata.head.versionId, expectedContentHash: metadata.head.contentHash, expectedAccessEpoch: app.policies.epoch(), expectedConfigId: metadata.configId };
    await action('metadata_changed', 'metadata', metadataInput);
    const beforeNoOp = (await app.summary()).unreadCount; assert.equal((await app.request(`/api/revisions/${id}/metadata`, 'POST', { ...metadataInput, expectedMetadataVersion: app.store.revisionMetadata.state(id).version }, 'alice', 'metadata-noop')).status, 200); assert.equal((await app.summary()).unreadCount, beforeNoOp);
    const reviews = app.store.revisionReviewers.snapshot(id, app.alice.id);
    await action('reviewers_changed', 'reviewers', { action: 'add', reviewerId: app.carol.id, message: 'Request a named review', expectedReviewerVersion: reviews.reviewers.version, expectedLifecycleVersion: reviews.lifecycle.version, expectedAuthorVersion: reviews.authorship.version, expectedVersion: reviews.head.number, expectedVersionId: reviews.head.versionId, expectedContentHash: reviews.head.contentHash, expectedAccessEpoch: app.policies.epoch(), expectedConfigId: reviews.configId, expectedEvidenceSha256: reviews.evidence.sha256 });
    const project = app.store.createProject({ name: 'Notification tag' }, app.actor);
    await action('projects_changed', 'projects', { action: 'add', projectIds: [project.id], expectedProjectVersion: app.store.revisionProjects.state(id).version, expectedAccessEpoch: app.policies.epoch() });
    const author = app.store.revisionAuthorship.snapshot(id);
    await action('author_changed', 'authorship', { action: 'assign', authorId: app.carol.id, message: 'Hand over the revision', expectedReviewerVersion: author.reviewerVersion, expectedLifecycleVersion: author.lifecycleVersion, expectedAuthorVersion: author.authorship.version, expectedVersion: author.head.number, expectedVersionId: author.head.versionId, expectedContentHash: author.head.contentHash, expectedAccessEpoch: app.policies.epoch() });
    const sub = app.store.revisionSubscriptions.snapshot(id, app.carol.id);
    await action('subscribers_changed', 'subscriptions', { action: 'subscribe', principalId: app.carol.id, expectedSubscriptionVersion: sub.viewer.version, expectedAuthorVersion: sub.authorVersion, expectedReviewerVersion: sub.reviewerVersion, expectedAccessEpoch: app.policies.epoch() });
    const comment = await app.comment(id), beforeReply = (await app.summary()).unreadCount;
    await action('replied', `threads/${comment.threadId}/replies`, { body: 'Another private message', viewedVersionId: comment.versionId });
    assert.equal((await app.summary()).unreadCount, beforeReply + 1);
    const beforeSilent = (await app.summary()).unreadCount, thread = app.store.detail(id).threads.find(item => item.id === comment.threadId)!;
    assert.equal((await app.request(`/api/revisions/${id}/threads/${thread.id}`, 'PATCH', { status: 'resolved', expectedThreadVersion: thread.version, versionId: comment.versionId }, 'alice', 'silent-resolution')).status, 200);
    const parent = app.revision().revision.id; assert.equal((await app.request(`/api/revisions/${id}/dependencies`, 'POST', { direction: 'parents', add: [parent], remove: [], expectedRelationshipVersion: app.store.revisionDependencies.version(id), expectedAccessEpoch: app.policies.epoch() }, 'alice', 'silent-dependency')).status, 200);
    assert.equal((await app.summary()).unreadCount, beforeSilent, 'thread resolution and dependency edits remain notification-silent');
    assert.ok((await app.inbox()).items.every(item => item.object.title === 'Renamed revision'), 'labels reflect current authorized metadata without rewriting events');
  } finally { await app.close(); }
});

test('notification receipts bind principal, exact request and key, revalidate current credentials, and roll back failed presentation', async () => {
  const app = await start();
  try {
    const id = app.revision().revision.id; await app.follow(id); await app.follow(id, 'carol'); await app.comment(id);
    const item = (await app.inbox()).items[0]!, input = app.mark(item); assert.equal((await app.request('/api/notifications/read', 'POST', input, 'bob', 'first-mark')).status, 200);
    const noOpInput = app.mark((await app.inbox()).items[0]!), first = await app.request<NotificationReceipt>('/api/notifications/read', 'POST', noOpInput, 'bob', 'noop-a'), second = await app.request<NotificationReceipt>('/api/notifications/read', 'POST', noOpInput, 'bob', 'noop-b'); assert.equal(first.status, 200); assert.equal(first.body.changed, false); assert.equal(second.status, 200);
    const foreign = await app.request<NotificationReceipt>('/api/notifications/read', 'POST', app.mark((await app.inbox('carol')).items[0]!), 'carol', 'carol-read'); assert.equal(foreign.status, 200);
    const row = app.store.database.prepare('SELECT key,body FROM idempotency WHERE key LIKE ?').get('%:noop-a') as { key: string; body: string }, get = app.store.notifications.operation.bind(app.store.notifications); let foreignLoads = 0;
    app.store.notifications.operation = operationId => { if (operationId === foreign.body.operationId) { foreignLoads++; throw new Error('Foreign operation loaded'); } return get(operationId); };
    for (const body of [second.body, foreign.body, { ...first.body, operationId: foreign.body.operationId }, { ...first.body, changed: true }]) { app.store.database.prepare('UPDATE idempotency SET body=? WHERE key=?').run(JSON.stringify(body), row.key); const denied = await app.request('/api/notifications/read', 'POST', noOpInput, 'bob', 'noop-a'); assert.equal(denied.status, 409); assert.equal(denied.body.code, 'NOTIFICATION_INVALID_RECEIPT'); }
    assert.equal(foreignLoads, 0); app.store.database.prepare('UPDATE idempotency SET body=? WHERE key=?').run(row.body, row.key); app.store.notifications.operation = get;
    const previous = app.tokens.bob.record.id; app.tokens.bob = app.auth.createToken(app.bob.id, { name: 'Rotated', scopes: ['read', 'write'] }); app.auth.revokeToken(app.bob.id, previous); assert.equal((await app.request('/api/notifications/read', 'POST', noOpInput, 'bob', 'noop-a')).status, 200);
    const before = await app.inbox(), unread = app.mark(before.items[0]!, 'unread');
    app.store.notifications.operation = () => { throw new Error('Injected canonical evidence failure'); };
    assert.equal((await app.request('/api/notifications/read', 'POST', unread, 'bob', 'failed-atomic-mark')).status, 409); app.store.notifications.operation = get;
    const after = await app.inbox(); assert.deepEqual(after.items, before.items); assert.equal(after.readVersion, before.readVersion); assert.equal(app.store.database.prepare('SELECT 1 FROM idempotency WHERE key LIKE ?').get('%:failed-atomic-mark'), undefined);
    app.auth.revokeToken(app.bob.id, app.tokens.bob.record.id); assert.equal((await app.request('/api/notifications/count')).status, 401); assert.equal((await app.request('/api/notifications/read', 'POST', noOpInput, 'bob', 'noop-a')).status, 401);
  } finally { await app.close(); }
});

test('notification marking rechecks current source access after waiting for the SQLite writer', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'notification-writer-')), databasePath = join(directory, 'workspace.sqlite'), app = await start('/', databasePath), transaction = app.store.transaction.bind(app.store);
  try {
    const id = app.revision().revision.id; await app.follow(id); await app.comment(id); const input = app.mark((await app.inbox()).items[0]!);
    const old = app.policies.policy(id, app.alice.id), policy = { ...old, version: old.version + 1, rules: { ...old.rules, view: members(app.alice.id) } };
    const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(`import {parentPort,workerData} from 'node:worker_threads';import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(workerData.databasePath);db.exec('PRAGMA busy_timeout=5000;BEGIN IMMEDIATE');db.prepare('UPDATE object_policies SET data=? WHERE object_id=?').run(JSON.stringify(workerData.policy),workerData.policy.objectId);db.prepare("UPDATE policy_meta SET value=value+1 WHERE name='epoch'").run();parentPort.once('message',()=>{db.exec('COMMIT');db.close();parentPort.close();});parentPort.postMessage('locked');`)}`), { workerData: { databasePath, policy } });
    try { assert.deepEqual(await once(worker, 'message'), ['locked']); let entered = 0; app.store.transaction = function<T>(work: () => T): T { entered++; app.store.transaction = transaction; worker.postMessage('commit'); return transaction(work); }; const denied = await app.request('/api/notifications/read', 'POST', input, 'bob', 'locked-read'); assert.equal(entered, 1); assert.equal(denied.status, 404); assert.equal(denied.body.code, 'NOTIFICATION_UNAVAILABLE'); assert.equal(app.store.database.prepare('SELECT 1 FROM idempotency WHERE key LIKE ?').get('%:locked-read'), undefined); }
    finally { app.store.transaction = transaction; await worker.terminate(); }
    app.policy(id, { view: workspace }); assert.equal((await app.inbox()).items[0]!.read, false);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('notification read writes require the current cookie context and CSRF', async () => {
  const app = await start(), cookies = new Map<string, string>();
  const acceptCookies = (headers: Headers) => { for (const cookie of headers.getSetCookie()) { const pair = cookie.split(';')[0]!, split = pair.indexOf('='); if (/max-age=0(?:;|$)/i.test(cookie)) cookies.delete(pair.slice(0, split)); else cookies.set(pair.slice(0, split), pair.slice(split + 1)); } }, cookieHeader = () => [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  try {
    const id = app.revision().revision.id; await app.follow(id); await app.comment(id); const input = app.mark((await app.inbox()).items[0]!);
    const bootstrap = await fetch(app.origin + '/api/session'); acceptCookies(bootstrap.headers); const boot = await bootstrap.json() as SessionState;
    const login = await fetch(app.origin + '/api/login', { method: 'POST', headers: { Cookie: cookieHeader(), Origin: app.origin, 'Content-Type': 'application/json', 'X-CSRF-Token': boot.csrfToken! }, body: JSON.stringify({ username: 'bob', password: 'Bob notification account password' }) }); assert.equal(login.status, 200); acceptCookies(login.headers); const session = await login.json() as SessionState;
    const headers = { Cookie: cookieHeader(), Origin: app.origin, 'Content-Type': 'application/json', 'Idempotency-Key': 'cookie-notification', 'X-Session-Context': session.sessionContext!, 'X-CSRF-Token': session.csrfToken! };
    for (const [invalid, status] of [[{ ...headers, 'X-CSRF-Token': 'invalid' }, 403], [{ ...headers, 'X-Session-Context': 'another-session' }, 401]] as const) assert.equal((await fetch(app.origin + '/api/notifications/read', { method: 'POST', headers: invalid, body: JSON.stringify(input) })).status, status);
    assert.equal((await fetch(app.origin + '/api/notifications/read', { method: 'POST', headers, body: JSON.stringify(input) })).status, 200); assert.equal((await app.summary()).unreadCount, 0);
  } finally { await app.close(); }
});
