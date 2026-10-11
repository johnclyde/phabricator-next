import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { AddressInfo } from 'node:net';
import { createApp, type AppOptions } from './app.ts';
import { createAuth } from './auth.ts';
import { Store } from './store.ts';
import { inspectDocx, replaceDocx } from './docx-package.ts';
import { createGitFixture } from '../tests/git-fixture.ts';
import type { ActorAttribution, AppState, RevisionDetail } from '../shared/types.ts';
import type { FileRecord } from '../shared/files.ts';
import type { SessionState } from '../shared/auth.ts';
import { revisionProjectInput, type RevisionProjectInput, type RevisionProjectSnapshot, type RevisionProjectReceipt, type RevisionProjectHistory } from '../shared/revision-projects.ts';

const members = (...principalIds: string[]) => ({ kind: 'principals' as const, principalIds }), workspace = { kind: 'workspace' as const };
type ErrorBody = { error: string; code?: string };
async function start(basePath = '/', databasePath = ':memory:', gitRepositories: Record<string, string> = {}, docxProcessor?: AppOptions['docxProcessor']) {
  const store = new Store({ path: databasePath }), provision = createAuth({ database: store.database, mode: 'local', basePath: '/', provisioning: true });
  const alice = await provision.createAccount({ username: 'alice', displayName: 'Alice Author', password: 'Alice project tags API password' });
  const bob = await provision.createAccount({ username: 'bob', displayName: 'Bob Editor', password: 'Bob project tags API password' });
  const app = createApp({ store, seed: false, authMode: 'password', basePath, gitRepositories, docxProcessor });
  const tokens = { alice: app.auth.createToken(alice.id, { name: 'Author', scopes: ['read', 'write'] }), bob: app.auth.createToken(bob.id, { name: 'Editor', scopes: ['read', 'write'] }), reader: app.auth.createToken(bob.id, { name: 'Read only', scopes: ['read'] }) };
  const actor: ActorAttribution = { principalId: alice.id, displayName: alice.displayName, credentialId: tokens.alice.record.id, requestId: 'project-tag-source' };
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}${basePath.replace(/\/$/, '')}`;
  async function request<T = ErrorBody>(path: string, method = 'GET', body?: unknown, who: keyof typeof tokens = 'alice', key?: string) {
    const response = await fetch(origin + path, { method, signal: AbortSignal.timeout(30_000), headers: { Authorization: `Bearer ${tokens[who].token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as T, headers: response.headers };
  }
  const path = (id: string) => `/api/revisions/${id}/projects`;
  const policy = (id: string, rules: Record<string, unknown>) => { const current = app.policies.policy(id, alice.id); return app.policies.setPolicy(id, { expectedVersion: current.version, spaceId: current.spaceId, ...current.rules, ...rules }, alice.id); };
  const revision = (extra = {}) => { const detail = store.createRevision({ testPlan: 'Inspect the source.', title: 'Tagged source', kind: 'paper', files: [{ path: 'source.txt', content: 'Exact manuscript\n' }], ...extra }, actor); policy(detail.revision.id, { view: workspace, edit: workspace, interact: members(alice.id) }); return detail; };
  const project = (name: string, extra: { parentId?: string; kind?: 'project' | 'milestone' } = {}) => { const preview = extra.parentId ? store.projectChildPreview(extra.parentId, extra.kind ?? 'project') : undefined; const item = store.createProject({ name, ...extra, ...(preview ? { expectedParentVersion: preview.expectedParentVersion, expectedHierarchyVersion: preview.expectedHierarchyVersion, expectedParentMembersVersion: preview.expectedParentMembersVersion, confirmMembershipConversion: preview.conversionRequired } : {}) }, actor); if (extra.kind !== 'milestone') policy(item.id, { view: workspace, edit: members(alice.id), interact: members(alice.id) }); return item; };
  const input = (id: string, action: RevisionProjectInput['action'], projectIds: string[]) => revisionProjectInput({ action, projectIds, expectedProjectVersion: store.revisionProjects.state(id).version, expectedAccessEpoch: app.policies.epoch() });
  const act = async (id: string, action: RevisionProjectInput['action'], projectIds: string[], who: keyof typeof tokens = 'bob', key: string = crypto.randomUUID()) => { const data = input(id, action, projectIds), response = await request<RevisionProjectReceipt>(path(id), 'POST', data, who, key); assert.equal(response.status, 200, JSON.stringify(response.body)); return { data, key, receipt: response.body }; };
  return { ...app, alice, bob, actor, tokens, origin, request, path, policy, revision, project, input, act, close: async () => { await app.close(); store.close(); } };
}

for (const basePath of ['/', '/mounted/']) test(`revision tags preserve exact source and saved tag sets at ${basePath}`, async () => {
  const app = await start(basePath);
  try {
    const first = app.project('First'), second = app.project('Second'), detail = app.revision({ projectIds: [first.id] }), id = detail.revision.id;
    const before = { versions: app.store.detail(id).versions, reviews: app.store.detail(id).reviews, lifecycle: app.store.revisionLifecycle.state(id), reviewers: app.store.revisionReviewers.state(id), author: app.store.revisionAuthorship.state(id), metadata: app.store.revisionMetadata.state(id) };
    const snapshot = await app.request<RevisionProjectSnapshot>(app.path(id), 'GET', undefined, 'reader'); assert.equal(snapshot.status, 200); assert.equal(snapshot.headers.get('cache-control'), 'no-store'); assert.deepEqual(snapshot.body.tags.projectIds, [first.id]);
    const added = await app.act(id, 'add', [second.id]); assert.equal(added.receipt.changed, true); assert.equal(added.receipt.transaction?.attribution.principalId, app.bob.id);
    const noOp = await app.act(id, 'add', [second.id]); assert.equal(noOp.receipt.changed, false); assert.equal(noOp.receipt.transaction, null);
    const removed = await app.act(id, 'remove', [first.id]); assert.deepEqual(removed.receipt.tags.projectIds, [second.id]);
    await app.act(id, 'set', []);
    for (const saved of [added, noOp, removed]) { const retry = await app.request<RevisionProjectReceipt>(app.path(id), 'POST', saved.data, 'bob', saved.key); assert.equal(retry.status, 200); assert.deepEqual(retry.body, saved.receipt); }
    assert.deepEqual({ versions: app.store.detail(id).versions, reviews: app.store.detail(id).reviews, lifecycle: app.store.revisionLifecycle.state(id), reviewers: app.store.revisionReviewers.state(id), author: app.store.revisionAuthorship.state(id), metadata: app.store.revisionMetadata.state(id) }, before);
    const pending = app.input(id, 'add', [first.id]); app.store.createVersion(id, { expectedVersion: 1, message: 'New exact source', files: [{ path: 'source.txt', content: 'New source\n' }] }, app.actor);
    assert.equal((await app.request(app.path(id), 'POST', pending, 'bob', 'after-source-change')).status, 200);
    assert.deepEqual((await app.request<AppState>('/api/state', 'GET', undefined, 'bob')).body.revisions.find(item => item.id === id)?.projectIds, [first.id]);
    const history = (await app.request<RevisionProjectHistory>(app.path(id) + '/history?limit=1', 'GET', undefined, 'bob')).body; assert.equal(history.transactions.length, 1); assert.ok(history.nextBefore);
    const next = (await app.request<RevisionProjectHistory>(app.path(id) + `/history?limit=1&before=${history.nextBefore}&expectedProjectVersion=${history.projectVersion}`)).body; assert.ok(next.transactions[0]!.projectVersion < history.transactions[0]!.projectVersion);
    for (const suffix of ['?extra=1', '/history?limit=101', '/history?before=0', '/history?limit=1&limit=2', '/history?expectedProjectVersion=999']) assert.ok([400, 409].includes((await app.request(app.path(id) + suffix)).status), suffix);
  } finally { await app.close(); }
});

test('hidden associations are normalized with the full hierarchy but never exposed by snapshots, history or exact retries', async () => {
  const app = await start();
  try {
    const parent = app.project('Visible ancestor'), child = app.project('Secret child', { parentId: parent.id, kind: 'project' }), other = app.project('Visible independent'), hidden = app.project('Hidden unrelated');
    const id = app.revision({ projectIds: [child.id, hidden.id] }).revision.id; app.policy(child.id, { view: members(app.alice.id) }); app.policy(hidden.id, { view: members(app.alice.id) });
    const initial = await app.request<RevisionProjectSnapshot>(app.path(id), 'GET', undefined, 'bob'); assert.deepEqual(initial.body.tags.projectIds, []);
    const added = await app.act(id, 'add', [parent.id]); assert.deepEqual(added.receipt.tags.projectIds, [parent.id]); assert.ok(app.store.revisionProjects.state(id).projectIds.includes(hidden.id)); assert.equal(app.store.revisionProjects.state(id).projectIds.includes(child.id), false);
    await app.act(id, 'add', [other.id]); const removed = await app.act(id, 'remove', [other.id]);
    for (const value of [added.receipt, removed.receipt, (await app.request(app.path(id) + '/history', 'GET', undefined, 'bob')).body, (await app.request(`/api/revisions/${id}`, 'GET', undefined, 'bob')).body]) { const text = JSON.stringify(value); assert.equal(text.includes(`"${child.id}"`), false); assert.equal(text.includes(`"${hidden.id}"`), false); assert.doesNotMatch(text, /Secret child|Hidden unrelated|hiddenCount|stateSha256/); }
    const retried = await app.request<RevisionProjectReceipt>(app.path(id), 'POST', added.data, 'bob', added.key); assert.equal(retried.status, 200); assert.deepEqual(retried.body.tags.projectIds, [parent.id]);
    await app.act(id, 'set', [], 'bob'); assert.deepEqual(app.store.revisionProjects.state(id).projectIds, []);
    app.policy(parent.id, { view: members(app.alice.id) });
    const denied = await app.request(app.path(id), 'POST', added.data, 'bob', added.key); assert.equal(denied.status, 404); assert.equal(denied.body.code, 'REVISION_PROJECT_UNAVAILABLE');
    const snapshot = await app.request(app.path(id), 'GET', undefined, 'bob'); assert.equal(snapshot.status, 200, 'a hidden selected project does not hide the source');
  } finally { await app.close(); }
});

test('tag authority needs source edit and selected project view, permits archived tags, and fails hidden references uniformly', async () => {
  const app = await start();
  try {
    const visible = app.project('Read-only project'), hidden = app.project('Hidden tag'), id = app.revision().revision.id;
    app.policy(hidden.id, { view: members(app.alice.id) });
    assert.equal((await app.request(app.path(id), 'POST', app.input(id, 'add', [visible.id]), 'reader', 'read-scope')).status, 403);
    const saved = await app.act(id, 'add', [visible.id]);
    app.store.updateProject(visible.id, { expectedVersion: app.store.getProject(visible.id).version, status: 'archived' }, app.actor);
    assert.equal((await app.request(app.path(id), 'POST', saved.data, 'bob', saved.key)).status, 200); await app.act(id, 'remove', [visible.id]); await app.act(id, 'add', [visible.id]);
    for (const action of ['add', 'remove', 'set'] as const) {
      const a = await app.request(app.path(id), 'POST', app.input(id, action, [hidden.id]), 'bob', `hidden-${action}`), b = await app.request(app.path(id), 'POST', app.input(id, action, ['PROJ999999']), 'bob', `missing-${action}`); assert.equal(a.status, 404); assert.deepEqual(a.body, b.body);
    }
    for (const projectIds of [[visible.id, visible.id], [1], null, Array(101).fill(visible.id)]) assert.equal((await app.request(app.path(id), 'POST', { ...app.input(id, 'set', []), projectIds }, 'bob', crypto.randomUUID())).status, 400);
    assert.equal((await app.request(app.path(id), 'POST', app.input(id, 'set', []), 'bob')).status, 400);
    app.policy(id, { edit: members(app.alice.id) }); assert.equal((await app.request(app.path(id), 'POST', saved.data, 'bob', saved.key)).status, 403);
    app.policy(id, { view: members(app.alice.id) }); assert.equal((await app.request(app.path(id), 'GET', undefined, 'bob')).status, 404);
  } finally { await app.close(); }
});

test('canonical project-tag receipts bind the original key and never load a foreign hidden operation', async () => {
  const app = await start();
  try {
    const tag = app.project('Tag'), id = app.revision().revision.id;
    await app.act(id, 'add', [tag.id]); const first = await app.act(id, 'add', [tag.id], 'bob', 'original-noop'), second = await app.act(id, 'add', [tag.id], 'bob', 'different-noop'); assert.deepEqual(first.data, second.data);
    const other = app.revision().revision.id, foreign = await app.act(other, 'add', [tag.id]); app.policy(other, { view: members(app.alice.id) });
    const row = app.store.database.prepare('SELECT * FROM idempotency WHERE key LIKE ?').get('%:original-noop') as { key: string; body: string }, getter = app.store.revisionProjects.operation.bind(app.store.revisionProjects); let hiddenLoads = 0;
    app.store.revisionProjects.operation = operationId => { if (operationId === foreign.receipt.operationId) { hiddenLoads++; throw new Error('Hidden operation loaded'); } return getter(operationId); };
    for (const value of [second.receipt, foreign.receipt, { ...first.receipt, operationId: foreign.receipt.operationId }, { ...first.receipt, changed: true }, { ...first.receipt, tags: { ...first.receipt.tags, projectIds: [] } }]) {
      app.store.database.prepare('UPDATE idempotency SET body=? WHERE key=?').run(JSON.stringify(value), row.key); const before = app.store.database.prepare('SELECT * FROM idempotency WHERE key=?').get(row.key);
      const denied = await app.request(app.path(id), 'POST', first.data, 'bob', first.key); assert.equal(denied.status, 409); assert.equal(denied.body.code, 'REVISION_PROJECT_INVALID_RECEIPT'); assert.deepEqual(app.store.database.prepare('SELECT * FROM idempotency WHERE key=?').get(row.key), before);
    }
    assert.equal(hiddenLoads, 0); app.store.database.prepare('UPDATE idempotency SET body=? WHERE key=?').run(row.body, row.key);
    const old = app.tokens.bob.record.id; app.tokens.bob = app.auth.createToken(app.bob.id, { name: 'Rotated editor', scopes: ['read', 'write'] }); app.auth.revokeToken(app.bob.id, old);
    assert.equal((await app.request(app.path(id), 'POST', first.data, 'bob', first.key)).status, 200);
  } finally { await app.close(); }
});

test('text, Git and Word creation accept ordered tags and retain historical creation/source receipt sets', async () => {
  const fixture = await createGitFixture(), app = await start('/', ':memory:', { R1: fixture.barePath });
  try {
    const first = app.project('Initial first'), second = app.project('Initial second'), later = app.project('Later tag');
    app.store.createRepository({ name: 'Tag source', remoteUrl: 'https://example.test/repo.git', defaultBranch: 'main' });
    const bytes = await readFile(new URL('../tests/fixtures/docx/roundtrip.docx', import.meta.url));
    const upload = await app.request<FileRecord>('/api/files', 'POST', { name: 'Tagged.docx', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), dataBase64: bytes.toString('base64') }, 'alice', 'tags-word-file'); assert.equal(upload.status, 201);
    const file = upload.body; app.policy(file.id, { view: workspace, edit: workspace });
    const requests = [
      { path: '/api/revisions', data: { kind: 'paper', files: [{ path: 'paper.txt', content: 'Original paper' }] } },
      { path: '/api/repositories/R1/import-revision', data: { kind: 'code', commitId: fixture.importCommit } },
      { path: '/api/revisions/docx', data: { sourceFile: { fileId: file.id, sha256: file.sha256, bytes: file.bytes }, shareSource: true, expectedAccessEpoch: app.policies.epoch() } },
    ];
    for (const [index, item] of requests.entries()) {
      const data = { ...item.data, ...('sourceFile' in item.data ? { expectedAccessEpoch: app.policies.epoch() } : {}), title: 'Tagged creation', testPlan: 'Inspect all sources.', projectIds: [second.id, first.id] }, key = `create-tags-${index}`;
      const created = await app.request<RevisionDetail>(item.path, 'POST', data, 'bob', key); assert.equal(created.status, 201, JSON.stringify(created.body)); assert.deepEqual(created.body.revision.projectIds, [first.id, second.id].sort());
      const id = created.body.revision.id; await app.act(id, 'set', [later.id], 'alice');
      const row = app.store.database.prepare('SELECT key,body FROM idempotency WHERE key LIKE ?').get(`%:${key}`) as { key: string; body: string }, original = JSON.parse(row.body) as RevisionDetail;
      const stripped = { ...original.revision }; delete stripped.projectIds; delete stripped.projectVersion;
      for (const revision of [{ ...original.revision, projectIds: [later.id] }, { ...original.revision, projectIds: [later.id], projectId: later.id, projectVersion: 1 }, { ...original.revision, projectVersion: undefined }, stripped]) {
        app.store.database.prepare('UPDATE idempotency SET body=? WHERE key=?').run(JSON.stringify({ ...original, revision }), row.key);
        const rejected = await app.request(item.path, 'POST', data, 'bob', key); assert.equal(rejected.status, 409); assert.equal(rejected.body.code, 'REVISION_PROJECT_INVALID_RECEIPT');
      }
      app.store.database.prepare('UPDATE idempotency SET body=? WHERE key=?').run(row.body, row.key);
      const repeated = await app.request<RevisionDetail>(item.path, 'POST', data, 'bob', key); assert.equal(repeated.status, 201, JSON.stringify(repeated.body)); assert.deepEqual(repeated.body.revision.projectIds, created.body.revision.projectIds);
      if (index === 0) {
        const sourceInput = { expectedVersion: 1, message: 'Later source receipt', files: [{ path: 'paper.txt', content: 'Next source' }] };
        const source = await app.request<RevisionDetail>(`/api/revisions/${id}/versions`, 'POST', sourceInput, 'alice', 'tag-source-version'); assert.equal(source.status, 201); await app.act(id, 'set', [], 'alice');
        const sourceRow = app.store.database.prepare('SELECT key,body FROM idempotency WHERE key LIKE ?').get('%:tag-source-version') as { key: string; body: string }, savedSource = JSON.parse(sourceRow.body) as RevisionDetail;
        for (const tags of [{ projectIds: [], projectId: null }, { projectIds: [], projectId: null, projectVersion: app.store.revisionProjects.state(id).version }]) {
          app.store.database.prepare('UPDATE idempotency SET body=? WHERE key=?').run(JSON.stringify({ ...savedSource, revision: { ...savedSource.revision, ...tags } }), sourceRow.key);
          assert.equal((await app.request(`/api/revisions/${id}/versions`, 'POST', sourceInput, 'alice', 'tag-source-version')).status, 409, 'even a real later tag state is not the state observed by the source receipt');
        }
        app.store.database.prepare('UPDATE idempotency SET body=? WHERE key=?').run(sourceRow.body, sourceRow.key);
        const retry = await app.request<RevisionDetail>(`/api/revisions/${id}/versions`, 'POST', sourceInput, 'alice', 'tag-source-version'); assert.equal(retry.status, 201); assert.deepEqual(retry.body.revision.projectIds, [later.id]);
      }
      app.policy(first.id, { view: members(app.alice.id) });
      assert.equal((await app.request(item.path, 'POST', data, 'bob', key)).status, 404, 'creation retries must recheck selected tags');
      app.policy(first.id, { view: workspace });
      if (index === 2) {
        const version = app.store.detail(id).versions[0]!, range = version.docx!.projection.editableRanges.find(item => item.text.length > 0)!;
        const noOpInput = { rangeId: range.id, start: 0, end: range.text.length, quote: range.text, replacement: range.text, message: 'Exact no-op source', expectedVersion: version.number, expectedVersionId: version.id, expectedContentHash: version.contentHash, expectedAccessEpoch: app.policies.epoch() }, noOpPath = `/api/revisions/${id}/docx/replace`;
        const firstNoOp = await app.request<RevisionDetail>(noOpPath, 'POST', noOpInput, 'bob', 'first-word-tag-noop'); assert.equal(firstNoOp.status, 201, JSON.stringify(firstNoOp.body));
        await app.act(id, 'set', [], 'alice');
        const laterNoOp = await app.request<RevisionDetail>(noOpPath, 'POST', noOpInput, 'bob', 'later-word-tag-noop'); assert.equal(laterNoOp.status, 201, JSON.stringify(laterNoOp.body)); assert.notEqual(firstNoOp.body.revision.projectVersion, laterNoOp.body.revision.projectVersion);
        const noOpRow = app.store.database.prepare('SELECT key,body FROM idempotency WHERE key LIKE ?').get('%:first-word-tag-noop') as { key: string; body: string }, laterRow = app.store.database.prepare('SELECT body FROM idempotency WHERE key LIKE ?').get('%:later-word-tag-noop') as { body: string };
        app.store.database.prepare('UPDATE idempotency SET body=? WHERE key=?').run(laterRow.body, noOpRow.key);
        assert.equal((await app.request(noOpPath, 'POST', noOpInput, 'bob', 'first-word-tag-noop')).status, 409, 'equal source versions cannot substitute a later no-op tag receipt');
        app.store.database.prepare('UPDATE idempotency SET body=? WHERE key=?').run(noOpRow.body, noOpRow.key);
        const recoveredNoOp = await app.request<RevisionDetail>(noOpPath, 'POST', noOpInput, 'bob', 'first-word-tag-noop'); assert.equal(recoveredNoOp.status, 201); assert.deepEqual(recoveredNoOp.body.revision.projectIds, firstNoOp.body.revision.projectIds);
        const space = app.policies.createSpace({ name: 'Original Word File ceiling', view: members(app.alice.id), edit: members(app.alice.id) }, app.alice.id);
        app.policy(file.id, { spaceId: space.id });
        assert.equal((await app.request(app.path(id), 'GET', undefined, 'bob')).status, 404);
        assert.equal((await app.request(app.path(id) + '/history', 'GET', undefined, 'bob')).status, 404);
      }
    }
    assert.equal((await app.request('/api/revisions', 'POST', { title: 'Ambiguous fields', testPlan: 'Plan', kind: 'code', files: [{ path: 'a', content: 'b' }], projectId: first.id, projectIds: [second.id] }, 'alice', 'ambiguous-tags')).status, 400);
  } finally { await app.close(); await fixture.close(); }
});

test('overlapping Word retries recover raw durable source receipts before filtering private project tags', async () => {
  let entered!: () => void, release!: () => void, joined!: () => void, calls = 0;
  const processing = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; }), duplicateJoined = new Promise<void>(resolve => { joined = resolve; });
  const app = await start('/', ':memory:', {}, { inspect: inspectDocx, replace: async (...args) => { calls++; entered(); await gate; return replaceDocx(...args); } });
  const running: Promise<unknown>[] = [];
  try {
    const tag = app.project('Private project'); app.policy(tag.id, { view: members(app.alice.id) });
    const bytes = await readFile(new URL('../tests/fixtures/docx/roundtrip.docx', import.meta.url));
    const upload = await app.request<FileRecord>('/api/files', 'POST', { name: 'Private-tagged.docx', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), dataBase64: bytes.toString('base64') }, 'alice', 'pending-tags-file'); assert.equal(upload.status, 201);
    const file = upload.body;
    const created = await app.request<RevisionDetail>('/api/revisions/docx', 'POST', { title: 'Shared Word source', testPlan: 'Inspect changes.', sourceFile: { fileId: file.id, sha256: file.sha256, bytes: file.bytes }, shareSource: true, projectIds: [tag.id], expectedAccessEpoch: app.policies.epoch() }, 'alice', 'pending-tags-create'); assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.revision.id; app.policy(id, { view: workspace, edit: workspace });
    const version = created.body.versions[0]!, range = version.docx!.projection.editableRanges.find(item => item.text.length > 0)!;
    const input = { rangeId: range.id, start: 0, end: range.text.length, quote: range.text, replacement: 'A shared revision with a private project tag.', message: 'Overlapping exact retry', expectedVersion: version.number, expectedVersionId: version.id, expectedContentHash: version.contentHash, expectedAccessEpoch: app.policies.epoch() }, path = `/api/revisions/${id}/docx/replace`, key = 'pending-private-tags';
    const replay = app.store.replay.bind(app.store); let lookups = 0;
    app.store.replay = (scopedKey, fingerprint) => { const result = replay(scopedKey, fingerprint); if (scopedKey.endsWith(`:${key}`) && ++lookups === 2) joined(); return result; };
    const first = app.request<RevisionDetail>(path, 'POST', input, 'bob', key); running.push(first);
    await Promise.race([processing, first.then(result => { throw new Error(`Word worker was not entered: ${JSON.stringify(result)}`); })]);
    const second = app.request<RevisionDetail>(path, 'POST', input, 'bob', key); running.push(second);
    await Promise.race([duplicateJoined, second.then(result => { throw new Error(`Duplicate did not wait for the pending operation: ${JSON.stringify(result)}`); })]);
    release();
    const responses = await Promise.all([first, second]);
    for (const response of responses) { assert.equal(response.status, 201, JSON.stringify(response.body)); assert.deepEqual(response.body.revision.projectIds, []); assert.equal(response.body.revision.projectId, null); assert.equal(JSON.stringify(response.body).includes(`"${tag.id}"`), false); }
    assert.deepEqual(responses[1]!.body, responses[0]!.body); assert.equal(calls, 1); assert.equal(app.store.detail(id).versions.length, 2);
    const saved = app.store.database.prepare('SELECT key, body FROM idempotency WHERE key LIKE ?').get(`%:${key}`) as { key: string; body: string };
    assert.deepEqual((JSON.parse(saved.body) as RevisionDetail).revision.projectIds, [tag.id], 'the immutable receipt retains complete tags before current visibility filtering');
    assert.ok(app.store.database.prepare('SELECT 1 FROM revision_project_response_bindings WHERE key_sha256=?').get(createHash('sha256').update(saved.key).digest('hex')));
    const later = await app.request<RevisionDetail>(path, 'POST', input, 'bob', key); assert.equal(later.status, 201); assert.deepEqual(later.body, responses[0]!.body); assert.equal(calls, 1);
  } finally { release(); await Promise.allSettled(running); await app.close(); }
});

test('source repository and Space ceilings apply to tags without deriving visibility from them', async () => {
  const app = await start();
  try {
    const tag = app.project('Visible project'), repository = app.store.createRepository({ name: 'Source', remoteUrl: 'https://example.test/repo.git', defaultBranch: 'main' });
    for (const ceiling of ['repository', 'space']) {
      const id = app.revision(ceiling === 'repository' ? { repositoryId: repository.id } : {}).revision.id, saved = await app.act(id, 'add', [tag.id]);
      if (ceiling === 'repository') app.policy(repository.id, { view: members(app.alice.id) });
      else { const space = app.policies.createSpace({ name: 'Private source Space', view: members(app.alice.id), edit: members(app.alice.id) }, app.alice.id); app.policy(id, { spaceId: space.id }); }
      assert.equal((await app.request(app.path(id), 'GET', undefined, 'bob')).status, 404); assert.equal((await app.request(app.path(id) + '/history', 'GET', undefined, 'bob')).status, 404); assert.equal((await app.request(app.path(id), 'POST', saved.data, 'bob', saved.key)).status, 404);
      assert.equal((await app.request<AppState>('/api/state', 'GET', undefined, 'bob')).body.revisions.some(revision => revision.id === id), false);
    }
  } finally { await app.close(); }
});

test('tag selection authority is rechecked under the SQLite writer lock including saved retries', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'phab-project-tag-lock-')), databasePath = join(directory, 'workspace.sqlite'), app = await start('/', databasePath), transaction = app.store.transaction.bind(app.store);
  try {
    for (const phase of ['fresh', 'replay'] as const) {
      const tag = app.project(`Selected ${phase}`), id = app.revision().revision.id, data = app.input(id, 'add', [tag.id]), key = `tag-lock-${phase}`;
      let replay: { key: string; fingerprint: string; status: number; body: string; created_at: string } | undefined;
      if (phase === 'replay') { assert.equal((await app.request(app.path(id), 'POST', data, 'bob', key)).status, 200); replay = app.store.database.prepare('SELECT * FROM idempotency WHERE key LIKE ?').get(`%:${key}`) as typeof replay; assert.ok(replay); app.store.database.prepare('DELETE FROM idempotency WHERE key=?').run(replay.key); }
      const old = app.policies.policy(tag.id, app.alice.id), policy = { ...old, version: old.version + 1, rules: { ...old.rules, view: members(app.alice.id) } }, before = app.store.revisionProjects.state(id);
      const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(`import { parentPort,workerData } from 'node:worker_threads'; import { DatabaseSync } from 'node:sqlite'; const db=new DatabaseSync(workerData.databasePath);db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');db.prepare('UPDATE object_policies SET data=? WHERE object_id=?').run(JSON.stringify(workerData.policy),workerData.policy.objectId);db.prepare("UPDATE policy_meta SET value=value+1 WHERE name='epoch'").run();if(workerData.replay){const r=workerData.replay;db.prepare('INSERT INTO idempotency(key,fingerprint,status,body,created_at) VALUES(?,?,?,?,?)').run(r.key,r.fingerprint,r.status,r.body,r.created_at);}parentPort.once('message',()=>{db.exec('COMMIT');db.close();parentPort.close();});parentPort.postMessage('locked');`)}`), { workerData: { databasePath, policy, replay } });
      try { assert.deepEqual(await once(worker, 'message'), ['locked']); let entered = 0; app.store.transaction = function<T>(work: () => T): T { entered++; app.store.transaction = transaction; worker.postMessage('commit'); return transaction(work); }; const denied = await app.request(app.path(id), 'POST', data, 'bob', key); assert.equal(entered, 1); assert.equal(denied.status, 404); assert.equal(denied.body.code, 'REVISION_PROJECT_UNAVAILABLE'); assert.deepEqual(app.store.revisionProjects.state(id), before); }
      finally { app.store.transaction = transaction; await worker.terminate(); }
    }
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('project-tag mutations require cookie session context and CSRF', async () => {
  const app = await start(), cookies = new Map<string, string>();
  const acceptCookies = (headers: Headers) => { for (const cookie of headers.getSetCookie()) { const pair = cookie.split(';')[0]!, split = pair.indexOf('='), name = pair.slice(0, split); if (/max-age=0(?:;|$)/i.test(cookie)) cookies.delete(name); else cookies.set(name, pair.slice(split + 1)); } };
  const cookieHeader = () => [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  try {
    const id = app.revision().revision.id, tag = app.project('Cookie tag');
    const bootstrap = await fetch(app.origin + '/api/session'); acceptCookies(bootstrap.headers); const boot = await bootstrap.json() as SessionState;
    const login = await fetch(app.origin + '/api/login', { method: 'POST', headers: { Cookie: cookieHeader(), Origin: app.origin, 'Content-Type': 'application/json', 'X-CSRF-Token': boot.csrfToken! }, body: JSON.stringify({ username: 'bob', password: 'Bob project tags API password' }) }); assert.equal(login.status, 200); acceptCookies(login.headers); const session = await login.json() as SessionState;
    const data = app.input(id, 'add', [tag.id]), headers = { Cookie: cookieHeader(), Origin: app.origin, 'Content-Type': 'application/json', 'Idempotency-Key': 'cookie-tags', 'X-Session-Context': session.sessionContext!, 'X-CSRF-Token': session.csrfToken! };
    for (const [invalid, status] of [[{ ...headers, 'X-CSRF-Token': 'invalid' }, 403], [{ ...headers, 'X-Session-Context': 'other-session' }, 401]] as const) assert.equal((await fetch(app.origin + app.path(id), { method: 'POST', headers: invalid, body: JSON.stringify(data) })).status, status);
    const saved = await fetch(app.origin + app.path(id), { method: 'POST', headers, body: JSON.stringify(data) }); assert.equal(saved.status, 200); assert.deepEqual(app.store.revisionProjects.state(id).projectIds, [tag.id]);
  } finally { await app.close(); }
});
