import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { AddressInfo } from 'node:net';
import { createApp } from './app.ts';
import { createAuth } from './auth.ts';
import { Store } from './store.ts';
import type { ActorAttribution, RevisionDetail } from '../shared/types.ts';
import type { FileRecord } from '../shared/files.ts';
import type { SessionState } from '../shared/auth.ts';
import { revisionMetadataInput, type RevisionMetadataInput, type RevisionMetadataSnapshot, type RevisionMetadataReceipt, type RevisionMetadataHistory } from '../shared/revision-metadata.ts';
import { createGitFixture } from '../tests/git-fixture.ts';
import { revisionMetadataInputHash } from './revision-metadata.ts';

const members = (...principalIds: string[]) => ({ kind: 'principals' as const, principalIds }), workspace = { kind: 'workspace' as const };
type ErrorBody = { error: string; code?: string };
async function start(basePath = '/', requireTestPlan = true, databasePath = ':memory:', gitRepositories: Record<string, string> = {}) {
  const store = new Store({ path: databasePath, revisionMetadata: { requireTestPlan } });
  const provision = createAuth({ database: store.database, mode: 'local', basePath: '/', provisioning: true });
  const alice = await provision.createAccount({ username: 'alice', displayName: 'Alice Author', password: 'Alice metadata API password long enough' });
  const bob = await provision.createAccount({ username: 'bob', displayName: 'Bob Editor', password: 'Bob metadata API password long enough' });
  const carol = await provision.createAccount({ username: 'carol', displayName: 'Carol Reviewer', password: 'Carol metadata API password long enough' });
  const app = createApp({ store, seed: false, authMode: 'password', basePath, gitRepositories });
  const tokens = { alice: app.auth.createToken(alice.id, { name: 'Author', scopes: ['read', 'write'] }), bob: app.auth.createToken(bob.id, { name: 'Editor', scopes: ['read', 'write'] }), carol: app.auth.createToken(carol.id, { name: 'Reviewer', scopes: ['read', 'write'] }), reader: app.auth.createToken(carol.id, { name: 'Read only', scopes: ['read'] }) };
  const actor: ActorAttribution = { principalId: alice.id, displayName: alice.displayName, credentialId: tokens.alice.record.id, requestId: 'initial-metadata-source' };
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}${basePath.replace(/\/$/, '')}`;
  async function request<T = ErrorBody>(path: string, method = 'GET', body?: unknown, who: keyof typeof tokens = 'alice', key?: string) {
    const response = await fetch(origin + path, { method, signal: AbortSignal.timeout(30_000), headers: { Authorization: `Bearer ${tokens[who].token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as T, headers: response.headers };
  }
  const path = (id: string) => `/api/revisions/${id}/metadata`;
  const policy = (id: string, rules: Record<string, unknown>, who = alice.id) => { const current = app.policies.policy(id, who); return app.policies.setPolicy(id, { expectedVersion: current.version, spaceId: current.spaceId, ...current.rules, ...rules }, who); };
  const revision = (kind: 'code' | 'paper' | 'document' = 'code', extra = {}) => {
      const detail = store.createRevision({ testPlan: 'Fixture verification plan.', title: 'Immutable review source', kind, files: [{ path: 'source.txt', content: 'Exact manuscript\n' }], ...extra }, actor);
    policy(detail.revision.id, { view: workspace, edit: members(alice.id, bob.id), interact: workspace }); return detail;
  };
  const input = (id: string, fields: Partial<Pick<RevisionMetadataInput, 'title' | 'summary' | 'testPlan'>> = {}): RevisionMetadataInput => {
    const s = store.revisionMetadata.snapshot(id);
    return revisionMetadataInput({ title: s.metadata.title, summary: s.metadata.summary, testPlan: s.metadata.testPlan ?? '', ...fields, message: '  Exact details message\n', expectedMetadataVersion: s.metadata.version, expectedVersion: s.head.number, expectedVersionId: s.head.versionId, expectedContentHash: s.head.contentHash, expectedAccessEpoch: app.policies.epoch(), expectedConfigId: s.configId });
  };
  const act = async (id: string, fields: Partial<Pick<RevisionMetadataInput, 'title' | 'summary' | 'testPlan'>> = {}, who: keyof typeof tokens = 'bob', key: string = crypto.randomUUID()) => { const data = input(id, fields), response = await request<RevisionMetadataReceipt>(path(id), 'POST', data, who, key); assert.equal(response.status, 200, JSON.stringify(response.body)); return { data, key, receipt: response.body }; };
  return { ...app, alice, bob, carol, actor, tokens, origin, request, path, policy, revision, input, act, close: async () => { await app.close(); store.close(); } };
}

for (const basePath of ['/', '/mounted/']) test(`metadata edits preserve exact source and acceptance with historical and no-op receipts at ${basePath}`, async () => {
  const app = await start(basePath);
  try {
    for (const kind of ['code', 'paper', 'document'] as const) {
      const detail = app.revision(kind), id = detail.revision.id;
      const reviews = app.store.revisionReviewers.snapshot(id);
      app.store.revisionReviewers.mutate(id, { action: 'accept', message: 'Read exact source', expectedReviewerVersion: reviews.reviewers.version, expectedLifecycleVersion: reviews.lifecycle.version, expectedAuthorVersion: reviews.authorship.version, expectedVersion: reviews.head.number, expectedVersionId: reviews.head.versionId, expectedContentHash: reviews.head.contentHash, expectedAccessEpoch: app.policies.epoch(), expectedConfigId: reviews.configId, expectedEvidenceSha256: reviews.evidence.sha256 }, { ...app.actor, principalId: app.carol.id, displayName: app.carol.displayName });
      const before = { versions: app.store.detail(id).versions, reviews: app.store.detail(id).reviews, lifecycle: app.store.revisionLifecycle.state(id), reviewers: app.store.revisionReviewers.state(id), author: app.store.revisionAuthorship.state(id) };
      const snapshot = await app.request<RevisionMetadataSnapshot>(app.path(id), 'GET', undefined, 'reader'); assert.equal(snapshot.status, 200); assert.equal(snapshot.headers.get('cache-control'), 'no-store'); assert.equal(snapshot.body.access.capabilities.edit, false); assert.equal(snapshot.body.config.requireTestPlan, true);
      const saved = await app.act(id, { title: 'é'.repeat(127) + 'a', summary: '\ufeff  Exact summary\r\n', testPlan: '\tInspect the exact source.\r\n' });
      assert.equal(saved.receipt.changed, true); assert.equal(saved.receipt.inputSha256, revisionMetadataInputHash(saved.data)); assert.equal(saved.receipt.transaction?.attribution.principalId, app.bob.id); assert.equal(saved.receipt.metadata.summary, saved.data.summary);
      assert.equal(app.store.detail(id).revision.title, saved.data.title); assert.equal(app.store.detail(id).revision.status, 'accepted');
      assert.deepEqual({ versions: app.store.detail(id).versions, reviews: app.store.detail(id).reviews, lifecycle: app.store.revisionLifecycle.state(id), reviewers: app.store.revisionReviewers.state(id), author: app.store.revisionAuthorship.state(id) }, before);
      const noOp = await app.act(id); assert.equal(noOp.receipt.changed, false); assert.equal(noOp.receipt.transaction, null); assert.equal(noOp.receipt.metadata.version, saved.receipt.metadata.version);
      await app.act(id, { title: 'A later title' });
      for (const original of [saved, noOp]) { const retry = await app.request<RevisionMetadataReceipt>(app.path(id), 'POST', original.data, 'bob', original.key); assert.equal(retry.status, 200); assert.deepEqual(retry.body, { ...original.receipt, accessEpoch: app.policies.epoch() }); }
      const current = (await app.request<RevisionMetadataSnapshot>(app.path(id))).body;
      const first = await app.request<RevisionMetadataHistory>(`${app.path(id)}/history?limit=1&expectedMetadataVersion=${current.metadata.version}`); assert.equal(first.status, 200); assert.equal(first.body.transactions.length, 1); assert.ok(first.body.nextBefore);
      const next = await app.request<RevisionMetadataHistory>(`${app.path(id)}/history?limit=1&before=${first.body.nextBefore}&expectedMetadataVersion=${current.metadata.version}`); assert.equal(next.status, 200); assert.equal(next.body.transactions[0]?.id, saved.receipt.transaction?.id);
      assert.equal((await app.request(`${app.path(id)}/history?expectedMetadataVersion=0`)).status, 409);
    }
  } finally { await app.close(); }
});

test('metadata writes require edit and exact pins; configuration, Unicode bounds, no-ops and concurrent writes fail safely', async () => {
  const app = await start();
  try {
    const id = app.revision().revision.id, input = app.input(id, { title: 'New title' });
    assert.equal((await app.request(app.path(id), 'POST', input, 'reader', 'read-only')).status, 403);
    assert.equal((await app.request(app.path(id), 'POST', input, 'carol', 'interact-only')).status, 403);
    assert.equal((await app.request(app.path(id), 'POST', input, 'bob')).status, 400);
    for (const fields of [{ title: 'é'.repeat(128) }, { title: '' }, { summary: 'x'.repeat(100001) }, { summary: '\ud800' }, { testPlan: '' }, { status: 'closed' }, { repositoryId: null }]) assert.equal((await app.request(app.path(id), 'POST', { ...input, ...fields }, 'bob', crypto.randomUUID())).status, 400, JSON.stringify(fields).slice(0, 150));
    for (const fields of [{ expectedMetadataVersion: 99 }, { expectedVersion: 99 }, { expectedVersionId: 'other' }, { expectedContentHash: 'f'.repeat(64) }, { expectedAccessEpoch: input.expectedAccessEpoch + 1 }, { expectedConfigId: 'e'.repeat(64) }]) assert.equal((await app.request(app.path(id), 'POST', { ...input, ...fields }, 'bob', crypto.randomUUID())).status, 409);
    for (const suffix of ['?extra=1', '/history?limit=0', '/history?limit=101', '/history?limit=1&limit=2', '/history?expectedMetadataVersion=-1', '/history?before=1.2']) assert.equal((await app.request(app.path(id) + suffix)).status, 400, suffix);
    const responses = await Promise.all(['race-one', 'race-two'].map(key => app.request(app.path(id), 'POST', input, 'bob', key))); assert.deepEqual(responses.map(value => value.status).sort(), [200, 409]);
    const key = responses[0]!.status === 200 ? 'race-one' : 'race-two'; assert.equal((await app.request(app.path(id), 'POST', { ...input, summary: 'Changed request' }, 'bob', key)).status, 409);
    app.policy(id, { interact: members() }); const whitespace = await app.act(id, { title: 'Editors do not need Interact', testPlan: ' \n\t' }); assert.equal(whitespace.receipt.metadata.testPlan, ' \n\t');
  } finally { await app.close(); }
});

test('metadata receipts bind immutable owner, exact fields, no-op proof and current principal before loading hidden evidence', async () => {
  const app = await start();
  try {
    const id = app.revision().revision.id, saved = await app.act(id, { title: 'Saved details' }, 'bob', 'canonical-metadata');
    const other = app.revision().revision.id, foreign = await app.act(other, { title: 'Hidden details' }); app.policy(other, { view: members(app.alice.id), edit: members(app.alice.id) });
    const row = app.store.database.prepare('SELECT key,body FROM idempotency WHERE key LIKE ?').get('%:canonical-metadata') as { key: string; body: string };
    const getter = app.store.revisionMetadata.operation.bind(app.store.revisionMetadata); let hiddenLoads = 0;
    app.store.revisionMetadata.operation = operationId => { if (operationId === foreign.receipt.operationId) { hiddenLoads++; throw new Error('Hidden evidence loaded'); } return getter(operationId); };
    for (const body of [foreign.receipt, { ...saved.receipt, operationId: foreign.receipt.operationId }, { ...saved.receipt, inputSha256: 'f'.repeat(64) }, { ...saved.receipt, metadata: { ...saved.receipt.metadata, title: 'Forged title' } }, { ...saved.receipt, changed: false, transaction: null }]) {
      app.store.database.prepare('UPDATE idempotency SET body=? WHERE key=?').run(JSON.stringify(body), row.key);
      assert.equal((await app.request(app.path(id), 'POST', saved.data, 'bob', saved.key)).status, 409);
    }
    assert.equal(hiddenLoads, 0); app.store.database.prepare('UPDATE idempotency SET body=? WHERE key=?').run(row.body, row.key);
    const old = app.tokens.bob.record.id; app.tokens.bob = app.auth.createToken(app.bob.id, { name: 'Rotated', scopes: ['read', 'write'] }); app.auth.revokeToken(app.bob.id, old);
    const retry = await app.request<RevisionMetadataReceipt>(app.path(id), 'POST', saved.data, 'bob', saved.key); assert.equal(retry.status, 200); assert.deepEqual(retry.body.transaction, saved.receipt.transaction);
    app.policy(id, { edit: members(app.alice.id) }); assert.equal((await app.request(app.path(id), 'POST', saved.data, 'bob', saved.key)).status, 403);
    app.policy(id, { view: members(app.alice.id) }); assert.equal((await app.request(app.path(id), 'POST', saved.data, 'bob', saved.key)).status, 404);
    assert.deepEqual((await app.request(app.path(id), 'GET', undefined, 'bob')).body, (await app.request('/api/revisions/D999999/metadata', 'GET', undefined, 'bob')).body);
  } finally { await app.close(); }
});

test('Word package metadata and its exact receipts remain subject to historical File visibility', async () => {
  const app = await start();
  try {
    const bytes = await readFile(new URL('../tests/fixtures/docx/roundtrip.docx', import.meta.url));
    const upload = await app.request<FileRecord>('/api/files', 'POST', { name: 'Metadata.docx', dataBase64: bytes.toString('base64'), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }, 'alice', 'metadata-word-file'); assert.equal(upload.status, 201);
    const file = upload.body, imported = await app.request<RevisionDetail>('/api/revisions/docx', 'POST', { testPlan: 'Inspect imported pages.', title: 'Word details', sourceFile: { fileId: file.id, sha256: file.sha256, bytes: file.bytes }, shareSource: true, expectedAccessEpoch: app.policies.epoch() }, 'alice', 'metadata-word-import'); assert.equal(imported.status, 201, JSON.stringify(imported.body));
    const id = imported.body.revision.id; app.policy(id, { view: workspace, edit: members(app.alice.id, app.bob.id) });
    const saved = await app.act(id, { title: 'Revised Word title', summary: 'Package unchanged.' }); assert.deepEqual(app.store.detail(id).versions, imported.body.versions);
    const space = app.policies.createSpace({ name: 'Private source package', view: members(app.alice.id), edit: members(app.alice.id) }, app.alice.id); app.policy(file.id, { spaceId: space.id });
    for (const suffix of ['', '/history']) assert.equal((await app.request(app.path(id) + suffix, 'GET', undefined, 'bob')).status, 404);
    assert.equal((await app.request(app.path(id), 'POST', saved.data, 'bob', saved.key)).status, 404);
  } finally { await app.close(); }
});

test('new text, Git and Word revisions require a test plan by default, including drafts', async () => {
  const fixture = await createGitFixture(), app = await start('/', true, ':memory:', { R1: fixture.barePath });
  try {
    const state = await app.request<{ revisionMetadataConfig: { requireTestPlan: boolean; configId: string } }>('/api/state'); assert.equal(state.body.revisionMetadataConfig.requireTestPlan, true); assert.match(state.body.revisionMetadataConfig.configId, /^[a-f0-9]{64}$/);
    for (const draft of [false, true]) {
      const data = { title: 'A new revision', kind: 'paper', draft, files: [{ path: 'paper.txt', content: 'Source' }] };
      assert.equal((await app.request('/api/revisions', 'POST', data, 'alice', crypto.randomUUID())).status, 400);
      const created = await app.request<RevisionDetail>('/api/revisions', 'POST', { ...data, testPlan: ' Inspect the source.\n' }, 'alice', crypto.randomUUID()); assert.equal(created.status, 201); assert.equal(created.body.revision.status, draft ? 'draft' : 'needs_review');
    }
    const repository = app.store.createRepository({ name: 'Test-plan source', remoteUrl: 'https://example.test/source.git', description: '', defaultBranch: 'main' }); assert.equal(repository.id, 'R1');
    const gitInput = { commitId: fixture.importCommit, title: 'Git draft', kind: 'code', draft: true };
    assert.equal((await app.request('/api/repositories/R1/import-revision', 'POST', gitInput, 'alice', 'git-no-plan')).status, 400);
    assert.equal((await app.request('/api/repositories/R1/import-revision', 'POST', { ...gitInput, testPlan: 'Inspect imported files.' }, 'alice', 'git-with-plan')).status, 201);
    const bytes = await readFile(new URL('../tests/fixtures/docx/roundtrip.docx', import.meta.url));
    const uploaded = await app.request<FileRecord>('/api/files', 'POST', { name: 'Draft.docx', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), dataBase64: bytes.toString('base64') }, 'alice', 'draft-word-file'); assert.equal(uploaded.status, 201);
    const file = uploaded.body, wordInput = { title: 'Word draft', draft: true, sourceFile: { fileId: file.id, bytes: file.bytes, sha256: file.sha256 }, shareSource: true, expectedAccessEpoch: app.policies.epoch() };
    assert.equal((await app.request('/api/revisions/docx', 'POST', wordInput, 'alice', 'word-no-plan')).status, 400);
    assert.equal((await app.request('/api/revisions/docx', 'POST', { ...wordInput, testPlan: 'Inspect imported pages.' }, 'alice', 'word-with-plan')).status, 201);
  } finally { await app.close(); await fixture.close(); }
});

test('historical creation and metadata receipts with omitted or empty plans survive a stricter operator configuration', async () => {
  const fixture = await createGitFixture(), directory = await mkdtemp(join(tmpdir(), 'metadata-retry-config-')), databasePath = join(directory, 'workspace.sqlite'), app = await start('/', false, databasePath, { R1: fixture.barePath });
  let reopened: ReturnType<typeof createApp> | undefined, reopenedStore: Store | undefined, originalClosed = false;
  try {
    const requests: { path: string; input: unknown; key: string; receipt: unknown }[] = [];
    const create = async (path: string, input: unknown, key: string) => { const result = await app.request<RevisionDetail>(path, 'POST', input, 'alice', key); assert.equal(result.status, 201, JSON.stringify(result.body)); const legacy = structuredClone(result.body); delete legacy.revision.testPlan; delete legacy.revision.metadataVersion; app.store.database.prepare('UPDATE idempotency SET body=? WHERE key=?').run(JSON.stringify(legacy), `${app.auth.workspaceId}:${app.alice.id}:${key}`); requests.push({ path, input, key, receipt: legacy }); return result.body; };
    const text = await create('/api/revisions', { title: 'Old text input', kind: 'paper', files: [{ path: 'paper.txt', content: 'Original' }] }, 'old-text');
    app.store.createRepository({ name: 'Old Git input', remoteUrl: 'https://example.test/old.git', description: '', defaultBranch: 'main' });
    await create('/api/repositories/R1/import-revision', { title: 'Old Git input', kind: 'code', commitId: fixture.importCommit }, 'old-git');
    const bytes = await readFile(new URL('../tests/fixtures/docx/roundtrip.docx', import.meta.url));
    const upload = await app.request<FileRecord>('/api/files', 'POST', { name: 'Old.docx', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), dataBase64: bytes.toString('base64') }, 'alice', 'old-word-file'); assert.equal(upload.status, 201);
    const file = upload.body; await create('/api/revisions/docx', { title: 'Old Word input', sourceFile: { fileId: file.id, bytes: file.bytes, sha256: file.sha256 }, shareSource: true, expectedAccessEpoch: app.policies.epoch() }, 'old-word');
    const edited = await app.act(text.revision.id, { title: 'Optional-plan metadata', testPlan: '' }, 'alice', 'old-metadata');
    const stored = app.store.database.prepare('SELECT * FROM idempotency ORDER BY key').all(), sourceRows = app.store.database.prepare('SELECT rowid,* FROM versions ORDER BY rowid').all();
    await app.close(); originalClosed = true;
    reopenedStore = new Store({ path: databasePath, revisionMetadata: { requireTestPlan: true } }); reopened = createApp({ store: reopenedStore, seed: false, authMode: 'password', gitRepositories: { R1: fixture.barePath } });
    await new Promise<void>(resolve => reopened!.server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(reopened.server.address() as AddressInfo).port}`;
    const replay = async (path: string, input: unknown, key: string) => { const response = await fetch(origin + path, { method: 'POST', headers: { Authorization: `Bearer ${app.tokens.alice.token}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(input) }); return { status: response.status, body: await response.json() }; };
    for (const request of requests) { const result = await replay(request.path, request.input, request.key); assert.equal(result.status, 201, JSON.stringify(result.body)); assert.deepEqual(result.body, { ...(request.receipt as RevisionDetail), accessEpoch: reopened.policies.epoch() }); const freshInput = request.path === '/api/revisions/docx' ? { ...(request.input as Record<string, unknown>), expectedAccessEpoch: reopened.policies.epoch() } : request.input; const fresh = await replay(request.path, freshInput, request.key + '-fresh'); assert.equal(fresh.status, 400, JSON.stringify(fresh.body)); }
    const metadata = await replay(app.path(text.revision.id), edited.data, edited.key); assert.equal(metadata.status, 200); assert.deepEqual(metadata.body, { ...edited.receipt, accessEpoch: reopened.policies.epoch() });
    assert.equal((await replay(app.path(text.revision.id), { ...edited.data, testPlan: 'Valid plan under the current configuration.' }, 'fresh-old-config')).status, 409);
    assert.deepEqual(reopenedStore.database.prepare('SELECT * FROM idempotency ORDER BY key').all(), stored); assert.deepEqual(reopenedStore.database.prepare('SELECT rowid,* FROM versions ORDER BY rowid').all(), sourceRows);
  } finally { if (!originalClosed) await app.close(); await reopened?.close(); reopenedStore?.close(); await fixture.close(); await rm(directory, { recursive: true, force: true }); }
});

test('repository and revision Space restrictions protect metadata history and saved receipts', async () => {
  const app = await start();
  try {
    for (const kind of ['repository', 'space'] as const) {
      const repository = app.store.createRepository({ name: 'Metadata source', remoteUrl: 'https://example.test/restricted.git', description: '', defaultBranch: 'main' }), id = app.revision('paper', { repositoryId: repository.id }).revision.id, saved = await app.act(id, { title: 'Restricted details' });
      if (kind === 'repository') app.policy(repository.id, { view: members(app.alice.id), edit: members(app.alice.id) });
      else { const space = app.policies.createSpace({ name: 'Private metadata', view: members(app.alice.id), edit: members(app.alice.id) }, app.alice.id); app.policy(id, { spaceId: space.id }); }
      for (const suffix of ['', '/history']) assert.equal((await app.request(app.path(id) + suffix, 'GET', undefined, 'bob')).status, 404);
      assert.equal((await app.request(app.path(id), 'POST', saved.data, 'bob', saved.key)).status, 404);
    }
  } finally { await app.close(); }
});

test('cookie-authenticated metadata edits require the current session context and CSRF token', async () => {
  const app = await start(); const cookies = new Map<string, string>();
  const acceptCookies = (headers: Headers) => { for (const cookie of headers.getSetCookie()) { const pair = cookie.split(';')[0]!, split = pair.indexOf('='), name = pair.slice(0, split); if (/max-age=0(?:;|$)/i.test(cookie)) cookies.delete(name); else cookies.set(name, pair.slice(split + 1)); } };
  const cookieHeader = () => [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  try {
    const id = app.revision().revision.id;
    const bootstrap = await fetch(app.origin + '/api/session'); acceptCookies(bootstrap.headers); const boot = await bootstrap.json() as SessionState;
    const login = await fetch(app.origin + '/api/login', { method: 'POST', headers: { Cookie: cookieHeader(), Origin: app.origin, 'Content-Type': 'application/json', 'X-CSRF-Token': boot.csrfToken! }, body: JSON.stringify({ username: 'bob', password: 'Bob metadata API password long enough' }) }); assert.equal(login.status, 200); acceptCookies(login.headers); const session = await login.json() as SessionState;
    const data = app.input(id, { title: 'Cookie-authenticated title' }), headers = { Cookie: cookieHeader(), Origin: app.origin, 'Content-Type': 'application/json', 'Idempotency-Key': 'cookie-metadata', 'X-Session-Context': session.sessionContext!, 'X-CSRF-Token': session.csrfToken! };
    for (const [invalid, status] of [[{ ...headers, 'X-CSRF-Token': 'invalid' }, 403], [{ ...headers, 'X-Session-Context': 'other-session' }, 401]] as const) assert.equal((await fetch(app.origin + app.path(id), { method: 'POST', headers: invalid, body: JSON.stringify(data) })).status, status);
    const saved = await fetch(app.origin + app.path(id), { method: 'POST', headers, body: JSON.stringify(data) }); assert.equal(saved.status, 200); assert.equal(app.store.detail(id).revision.title, data.title);
  } finally { await app.close(); }
});

test('metadata edit authorization is checked under the SQLite writer lock for fresh and saved requests', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'phab-metadata-lock-')), databasePath = join(directory, 'workspace.sqlite'), app = await start('/', true, databasePath), transaction = app.store.transaction.bind(app.store);
  try {
    for (const phase of ['fresh', 'replay'] as const) {
      const id = app.revision().revision.id, data = app.input(id, { title: 'Writer-lock details' }), key = `metadata-lock-${phase}`;
      let replay: { key: string; fingerprint: string; status: number; body: string; created_at: string } | undefined;
      if (phase === 'replay') { assert.equal((await app.request(app.path(id), 'POST', data, 'bob', key)).status, 200); replay = app.store.database.prepare('SELECT * FROM idempotency WHERE key LIKE ?').get(`%:${key}`) as typeof replay; assert.ok(replay); app.store.database.prepare('DELETE FROM idempotency WHERE key=?').run(replay.key); }
      const original = app.policies.policy(id, app.alice.id), policy = { ...original, version: original.version + 1, rules: { ...original.rules, edit: members(app.alice.id) } }, before = app.store.detail(id), history = app.store.revisionMetadata.history(id);
      const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(`
        import { parentPort, workerData } from 'node:worker_threads'; import { DatabaseSync } from 'node:sqlite';
        const db=new DatabaseSync(workerData.databasePath);db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');db.prepare('UPDATE object_policies SET data=? WHERE object_id=?').run(JSON.stringify(workerData.policy),workerData.policy.objectId);db.prepare("UPDATE policy_meta SET value=value+1 WHERE name='epoch'").run();
        if(workerData.replay){const r=workerData.replay;db.prepare('INSERT INTO idempotency(key,fingerprint,status,body,created_at) VALUES(?,?,?,?,?)').run(r.key,r.fingerprint,r.status,r.body,r.created_at);}parentPort.once('message',()=>{db.exec('COMMIT');db.close();parentPort.close();});parentPort.postMessage('locked');
      `)}`), { workerData: { databasePath, policy, replay } });
      try {
        assert.deepEqual(await once(worker, 'message'), ['locked']); let entered = 0;
        app.store.transaction = function<T>(work: () => T): T { entered++; app.store.transaction = transaction; worker.postMessage('commit'); return transaction(work); };
        const denied = await app.request(app.path(id), 'POST', data, 'bob', key); assert.equal(entered, 1); assert.equal(denied.status, 403); assert.deepEqual(app.store.detail(id), before); assert.deepEqual(app.store.revisionMetadata.history(id), history);
      } finally { app.store.transaction = transaction; await worker.terminate(); }
    }
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
