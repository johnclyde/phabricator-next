import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { createApp } from './app.ts';
import { createAuth } from './auth.ts';
import { Store } from './store.ts';
import { isStoredMentionProof } from './mentions.ts';
import type { ActorAttribution, ReviewComment, RevisionDetail, TaskTransaction } from '../shared/types.ts';
import type { PasteTransaction } from '../shared/pastes.ts';
import type { FileRecord } from '../shared/files.ts';
import type { MentionProof } from '../shared/mentions.ts';

const members = (...principalIds: string[]) => ({ kind: 'principals' as const, principalIds }), workspace = { kind: 'workspace' as const };
type Comment = (ReviewComment | TaskTransaction | PasteTransaction) & { mentions?: MentionProof };
async function start(basePath = '/', beforeApp?: (store: Store, actor: ActorAttribution) => void) {
  const store = new Store({ path: ':memory:' });
  const provision = createAuth({ database: store.database, mode: 'local', basePath, provisioning: true });
  const alice = await provision.createAccount({ username: 'alice', displayName: 'Alice', password: 'Alice mention integration password' });
  const bob = await provision.createAccount({ username: 'bob', displayName: 'Bob', password: 'Bob mention integration password' });
  beforeApp?.(store, { principalId: alice.id, displayName: alice.displayName, credentialId: null, requestId: 'legacy-fixture' });
  const app = createApp({ store, seed: false, authMode: 'password', basePath });
  const tokens = { alice: app.auth.createToken(alice.id, { name: 'Author', scopes: ['read', 'write'] }), bob: app.auth.createToken(bob.id, { name: 'Reader', scopes: ['read', 'write'] }), reader: app.auth.createToken(bob.id, { name: 'Read only', scopes: ['read'] }) };
  const actor = { principalId: alice.id, displayName: alice.displayName, credentialId: tokens.alice.record.id, requestId: 'mention-fixture' };
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}${basePath.replace(/\/$/, '')}`;
  async function request<T = { error: string; code?: string }>(path: string, method = 'GET', body?: unknown, who: keyof typeof tokens = 'alice', key?: string) {
    const response = await fetch(origin + path, { method, signal: AbortSignal.timeout(30_000), headers: { Authorization: `Bearer ${tokens[who].token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as T };
  }
  const policy = (id: string, rules: Record<string, unknown>) => { const current = app.policies.policy(id, alice.id); return app.policies.setPolicy(id, { expectedVersion: current.version, spaceId: current.spaceId, ...current.rules, ...rules }, alice.id); };
  const revision = (kind: 'code' | 'paper' | 'document' = 'code', extra = {}) => store.createRevision({ title: 'Mention source', testPlan: 'Read exact source.', kind, files: [{ path: 'source.txt', content: 'Exact manuscript\n' }], ...extra }, actor);
  async function word() {
    const bytes = await readFile(new URL('../tests/fixtures/docx/roundtrip.docx', import.meta.url));
    const file = await request<FileRecord>('/api/files', 'POST', { name: 'Mentions.docx', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), dataBase64: bytes.toString('base64') }, 'alice', randomUUID()); assert.equal(file.status, 201);
    const detail = await request<RevisionDetail>('/api/revisions/docx', 'POST', { title: 'Word mentions', testPlan: 'Inspect passage.', sourceFile: { fileId: file.body.id, sha256: file.body.sha256, bytes: file.body.bytes }, shareSource: true, expectedAccessEpoch: app.policies.epoch() }, 'alice', randomUUID()); assert.equal(detail.status, 201, JSON.stringify(detail.body));
    return { detail: detail.body, file: file.body };
  }
  const rows = () => ['comments', 'task_transactions', 'paste_transactions', 'review_threads', 'revision_subscription_transactions', 'object_subscription_transactions', 'notification_events', 'notification_deliveries', 'idempotency'].map(table => store.database.prepare(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all());
  return { ...app, alice, bob, actor, tokens, request, policy, revision, word, rows, close: async () => { await app.close(); store.close(); } };
}

for (const basePath of ['/', '/mounted/']) test(`new discussion mentions bind once and exact retries preserve identities across all source kinds at ${basePath}`, async () => {
  const app = await start(basePath);
  try {
    const body = ' Please @BOB and @bob; @future stays literal. Email a@bob and `@alice` stay literal.  ';
    const paths: { path: string; input: Record<string, unknown>; id: string }[] = [];
    for (const kind of ['code', 'paper', 'document'] as const) {
      const detail = app.revision(kind); paths.push({ path: `/api/revisions/${detail.revision.id}/comments`, input: { body, versionId: detail.versions[0]!.id }, id: detail.revision.id });
    }
    const word = await app.word(), version = word.detail.versions[0]!, range = version.docx!.projection.editableRanges.find(r => r.text === 'The original result is clear.')!;
    paths.push({ path: `/api/revisions/${word.detail.revision.id}/comments`, input: { body, versionId: version.id, docxPassage: { rangeId: range.id, start: 4, end: 12, quote: 'original' } }, id: word.detail.revision.id });
    const task = app.store.createTask({ title: 'Mention task' }, app.actor); paths.push({ path: `/api/tasks/${task.id}/comments`, input: { body }, id: task.id });
    const paste = app.store.pastes.create({ content: 'Exact paste source' }, app.actor); paths.push({ path: `/api/pastes/${paste.id}/comments`, input: { body, contentVersion: 1 }, id: paste.id });
    for (const { path, input, id } of paths) {
      const key = randomUUID(), first = await app.request<Comment>(path, 'POST', input, 'alice', key); assert.equal(first.status, 201, JSON.stringify(first.body));
      assert.ok(isStoredMentionProof(first.body.mentions, id.startsWith('PA') ? body.trim() : body));
      assert.deepEqual(first.body.mentions!.tokens.map(t => [t.spelling, t.principalId]), [['BOB', app.bob.id], ['bob', app.bob.id], ['future', null]]);
      const before = app.rows(), original = app.policies.access.bind(app.policies);
      app.policies.access = (target, principal) => { if (principal === app.bob.id) throw new Error('Retry must not resolve current mentioned account access'); return original(target, principal); };
      const retry = await app.request(path, 'POST', input, 'alice', key); app.policies.access = original;
      assert.equal(retry.status, 201, JSON.stringify(retry.body)); assert.deepEqual(retry.body, first.body); assert.deepEqual(app.rows(), before);
      if (id.startsWith('D') || id.startsWith('P') && !id.startsWith('PA') || id.startsWith('L')) {
        const root = first.body as ReviewComment, replyPath = `/api/revisions/${id}/threads/${root.threadId}/replies`, replyInput = { body: '@bob please respond.', viewedVersionId: input.versionId };
        const replied = await app.request<ReviewComment>(replyPath, 'POST', replyInput, 'alice', key + '-reply'); assert.equal(replied.status, 201); assert.equal(replied.body.mentions!.tokens[0]!.principalId, app.bob.id);
        assert.deepEqual((await app.request(replyPath, 'POST', replyInput, 'alice', key + '-reply')).body, replied.body);
        assert.equal(replied.body.versionId, root.versionId); assert.deepEqual(replied.body.docxAnchor, root.docxAnchor);
      }
    }
    assert.equal(app.store.taskDetail(task.id).task.version, 1); assert.equal(app.store.pastes.detail(paste.id).paste.contentVersion, 1);
    assert.deepEqual(app.store.detail(word.detail.revision.id).versions, word.detail.versions);
  } finally { await app.close(); }
});

test('resolution obeys current repository, Space and historical Word File ceilings without granting visibility', async () => {
  const app = await start();
  try {
    for (const ceiling of ['repository', 'space', 'file'] as const) {
      const repo = app.store.createRepository({ name: 'Private source', remoteUrl: 'https://example.test/repo.git', defaultBranch: 'main' }, app.actor);
      const word = ceiling === 'file' ? await app.word() : null, detail = word?.detail ?? app.revision('paper', { repositoryId: repo.id }), id = detail.revision.id;
      if (ceiling === 'repository') app.policy(repo.id, { view: members(app.alice.id) });
      else { const space = app.policies.createSpace({ name: 'Private mention source', view: members(app.alice.id), edit: members(app.alice.id) }, app.alice.id); app.policy(word?.file.id ?? id, { spaceId: space.id }); }
      const response = await app.request<ReviewComment>(`/api/revisions/${id}/comments`, 'POST', { body: '@bob', versionId: detail.versions[0]!.id }, 'alice', ceiling);
      assert.equal(response.status, 201, JSON.stringify(response.body)); assert.equal(response.body.mentions!.tokens[0]!.principalId, null);
      assert.equal(app.store.revisionSubscriptions.effective(id, app.bob.id), false); assert.equal((await app.request(`/api/revisions/${id}`, 'GET', undefined, 'bob')).status, 404);
    }
  } finally { await app.close(); }
});

test('account changes never reinterpret stored mentions, and current comment authority is enforced before retry', async () => {
  const app = await start();
  try {
    const detail = app.revision('paper'), id = detail.revision.id, path = `/api/revisions/${id}/comments`, input = { body: '@bob @future', versionId: detail.versions[0]!.id };
    app.auth.setAccountDisabled(app.bob.id, true);
    const saved = await app.request<ReviewComment>(path, 'POST', input, 'alice', 'account-once'); assert.equal(saved.status, 201); assert.deepEqual(saved.body.mentions!.tokens.map(t => t.principalId), [null, null]);
    app.auth.setAccountDisabled(app.bob.id, false); const future = await app.auth.createAccount({ username: 'future', displayName: 'Future', password: 'Future mention integration password' });
    const before = app.rows(), retried = await app.request(path, 'POST', input, 'alice', 'account-once'); assert.equal(retried.status, 201); assert.deepEqual((retried.body as unknown as ReviewComment).mentions, saved.body.mentions); assert.deepEqual(app.rows(), before);
    const newer = await app.request<ReviewComment>(path, 'POST', input, 'alice', 'account-new'); assert.deepEqual(newer.body.mentions!.tokens.map(t => t.principalId), [app.bob.id, future.id]);
    app.tokens.reader = app.auth.createToken(app.bob.id, { name: 'Read only again', scopes: ['read'] });
    assert.equal((await app.request(path, 'POST', input, 'reader', 'read-only')).status, 403);
    app.policy(id, { edit: members(app.bob.id), interact: members(app.bob.id) });
    assert.equal((await app.request(path, 'POST', input, 'alice', 'account-once')).status, 403);
    app.policy(id, { edit: workspace, interact: workspace });
    assert.equal((await app.request(path, 'POST', { ...input, body: Array(101).fill('@bob').join(' ') }, 'alice', 'too-many')).status, 400);
    assert.equal(app.store.database.prepare('SELECT 1 FROM idempotency WHERE key LIKE ?').get('%:too-many'), undefined);
  } finally { await app.close(); }
});

test('saved comment recovery rejects missing, forged or foreign mention proof before returning it', async () => {
  const app = await start();
  try {
    const detail = app.revision(), id = detail.revision.id, task = app.store.createTask({ title: 'Receipt task' }, app.actor), paste = app.store.pastes.create({ content: 'Source' }, app.actor);
    for (const [path, input] of [[`/api/revisions/${id}/comments`, { body: '@bob', versionId: detail.versions[0]!.id }], [`/api/tasks/${task.id}/comments`, { body: '@bob' }], [`/api/pastes/${paste.id}/comments`, { body: '@bob', contentVersion: 1 }]] as const) {
      const key = randomUUID(), saved = await app.request<Comment>(path, 'POST', input, 'alice', key); assert.equal(saved.status, 201);
      const row = app.store.database.prepare('SELECT key,body FROM idempotency WHERE key LIKE ?').get('%:' + key) as { key: string; body: string }, original = JSON.parse(row.body) as Record<string, unknown>, missing = { ...original }; delete missing.mentions;
      const other = await app.request<Comment>(path, 'POST', input, 'alice', key + '-other'); assert.equal(other.status, 201);
      const { accessEpoch: _epoch, ...otherSaved } = other.body as Comment & { accessEpoch?: number };
      for (const bad of [missing, otherSaved, { ...original, id: randomUUID() }, { ...original, mentions: { ...saved.body.mentions, bodySha256: '0'.repeat(64) } }, { ...original, mentions: { ...saved.body.mentions, requestSha256: '0'.repeat(64) } }, { ...original, mentions: { ...saved.body.mentions, tokens: [] } }]) {
        app.store.database.prepare('UPDATE idempotency SET body=? WHERE key=?').run(JSON.stringify(bad), row.key);
        const rejected = await app.request(path, 'POST', input, 'alice', key); assert.equal(rejected.status, 409); assert.equal(rejected.body.code, 'MENTION_INVALID_RECEIPT');
      }
      app.store.database.prepare('UPDATE idempotency SET body=? WHERE key=?').run(row.body, row.key); assert.deepEqual((await app.request(path, 'POST', input, 'alice', key)).body, saved.body);
    }
  } finally { await app.close(); }
});

test('same-body responses from another source version or reply thread cannot substitute saved mention identities', async () => {
  const app = await start();
  try {
    const detail = app.revision(), id = detail.revision.id, path = `/api/revisions/${id}/comments`, input = { body: '@bob same words', versionId: detail.versions[0]!.id };
    const first = await app.request<ReviewComment>(path, 'POST', input, 'alice', 'version-original'); assert.equal(first.status, 201);
    const newer = app.store.createVersion(id, { expectedVersion: 1, files: [{ path: 'source.txt', content: 'Different immutable source' }], message: 'Next source' }, app.actor).versions.find(v => v.number === 2)!;
    const other = await app.request<ReviewComment>(path, 'POST', { ...input, versionId: newer.id }, 'alice', 'version-other'); assert.equal(other.status, 201);
    const row = app.store.database.prepare('SELECT key,body FROM idempotency WHERE key LIKE ?').get('%:version-original') as { key: string; body: string };
    app.store.database.prepare('UPDATE idempotency SET body=? WHERE key=?').run(JSON.stringify(other.body), row.key);
    assert.equal((await app.request(path, 'POST', input, 'alice', 'version-original')).status, 409);
    app.store.database.prepare('UPDATE idempotency SET body=? WHERE key=?').run(row.body, row.key);
    const replyPath = `/api/revisions/${id}/threads/${first.body.threadId}/replies`, replyInput = { body: '@bob same reply', viewedVersionId: newer.id };
    const reply = await app.request<ReviewComment>(replyPath, 'POST', replyInput, 'alice', 'reply-original'); assert.equal(reply.status, 201);
    const wrongThread = await app.request<ReviewComment>(`/api/revisions/${id}/threads/${other.body.threadId}/replies`, 'POST', replyInput, 'alice', 'reply-other'); assert.equal(wrongThread.status, 201);
    const replyRow = app.store.database.prepare('SELECT key FROM idempotency WHERE key LIKE ?').get('%:reply-original') as { key: string };
    app.store.database.prepare('UPDATE idempotency SET body=? WHERE key=?').run(JSON.stringify(wrongThread.body), replyRow.key);
    assert.equal((await app.request(replyPath, 'POST', replyInput, 'alice', 'reply-original')).status, 409);
  } finally { await app.close(); }
});

test('genuine legacy receipts stay literal but cannot replace a request with recorded mention evidence', async () => {
  const legacy: { path: string; input: Record<string, unknown>; comment: Comment }[] = [];
  const app = await start('/', (store, actor) => {
    const detail = store.createRevision({ title: 'Old discussion', kind: 'paper', testPlan: 'Read.', files: [{ path: 'paper.tex', content: 'Source' }] }, actor);
    const revisionInput = { body: '@bob', versionId: detail.versions[0]!.id };
    legacy.push({ path: `/api/revisions/${detail.revision.id}/comments`, input: revisionInput, comment: store.createComment(detail.revision.id, revisionInput, actor) });
    const task = store.createTask({ title: 'Old task' }, actor), paste = store.pastes.create({ content: 'Old paste' }, actor);
    legacy.push({ path: `/api/tasks/${task.id}/comments`, input: { body: '@bob' }, comment: store.createTaskComment(task.id, { body: '@bob' }, actor) });
    legacy.push({ path: `/api/pastes/${paste.id}/comments`, input: { body: '@bob', contentVersion: 1 }, comment: store.pastes.comment(paste.id, { body: '@bob', contentVersion: 1 }, actor) });
  });
  try {
    for (const { path, input, comment } of legacy) {
      assert.equal(comment.mentions, undefined);
      const oldKey = randomUUID(), key = `${app.auth.workspaceId}:${app.alice.id}:${oldKey}`, fingerprint = createHash('sha256').update(JSON.stringify(['POST', path, input])).digest('hex');
      app.store.database.prepare('INSERT INTO idempotency(key,fingerprint,status,body,created_at) VALUES(?,?,?,?,?)').run(key, fingerprint, 201, JSON.stringify(comment), comment.createdAt);
      const old = await app.request<Comment>(path, 'POST', input, 'alice', oldKey); assert.equal(old.status, 201, JSON.stringify(old.body)); assert.equal(old.body.mentions, undefined); assert.equal(old.body.id, comment.id);
      const newKey = randomUUID(), fresh = await app.request<Comment>(path, 'POST', input, 'alice', newKey); assert.equal(fresh.status, 201); assert.ok(fresh.body.mentions);
      app.store.database.prepare('UPDATE idempotency SET body=? WHERE key=?').run(JSON.stringify(comment), `${app.auth.workspaceId}:${app.alice.id}:${newKey}`);
      const rejected = await app.request(path, 'POST', input, 'alice', newKey); assert.equal(rejected.status, 409); assert.equal(rejected.body.code, 'MENTION_INVALID_RECEIPT');
      assert.equal((await app.request<Comment>(path, 'POST', input, 'alice', oldKey)).body.mentions, undefined);
    }
  } finally { await app.close(); }
});
