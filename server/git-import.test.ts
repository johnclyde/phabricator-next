import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { createApp, type AppOptions } from './app.ts';
import { createStore, contentHash } from './store.ts';
import { createAuth } from './auth.ts';
import { createGitObserver, type GitObserver } from './git.ts';
import { HttpError } from './validation.ts';
import { createGitFixture } from '../tests/git-fixture.ts';
import type { GitImportSnapshot } from '../shared/repositories.ts';
import type { AppState, RevisionDetail, ReviewAnalysis } from '../shared/types.ts';
import type { ObjectAccess } from '../shared/policy.ts';

const commitId = 'a'.repeat(40); const treeId = 'b'.repeat(40);
const source = [{ path: 'README.md', content: '\ufeffImported text.\n' }, { path: 'run.sh', content: '#!/bin/sh\nexit 0\n' }];
const snapshot = (): GitImportSnapshot => ({ repositoryId: 'R1', objectFormat: 'sha1', files: structuredClone(source), provenance: { kind: 'git', repositoryId: 'R1', objectFormat: 'sha1', commitId, treeId, scope: 'complete-text-tree', manifest: source.map((file, index) => ({ path: file.path, mode: index ? '100755' : '100644', objectId: createHash('sha1').update(`blob ${Buffer.byteLength(file.content)}\0`).update(file.content).digest('hex') })) } });
const input = (title = 'Imported review') => ({ commitId, kind: 'code', title });
const route = '/api/repositories/R1/import-revision';
const members = (...principalIds: string[]) => ({ kind: 'principals' as const, principalIds });
const workspace = { kind: 'workspace' as const };
type ErrorBody = { error: string; code?: string };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function observer(importSnapshot: GitObserver['importSnapshot'] = async () => snapshot()): GitObserver {
  const unavailable = async (): Promise<never> => { throw new HttpError(503, 'Fixture read unavailable.', 'GIT_UNAVAILABLE'); };
  return { importSnapshot, info: async () => ({ state: 'ready', objectFormat: 'sha1' }), refs: unavailable, commit: unavailable, tree: unavailable, blob: unavailable, history: unavailable };
}
async function start(options: AppOptions = {}) {
  const store = createStore({ path: options.databasePath ?? ':memory:' });
  const provision = createAuth({ database: store.database, mode: 'local', basePath: '/', provisioning: true });
  const alice = await provision.createAccount({ username: 'alice', displayName: 'Alice', password: 'Alice immutable Git import password' });
  const bob = await provision.createAccount({ username: 'bob', displayName: 'Bob', password: 'Bob immutable Git import password' });
  const app = createApp({ ...options, store, seed: false, authMode: 'password', gitObserver: options.gitObserver ?? observer() });
  store.createRepository({ name: 'Git source', remoteUrl: 'https://example.invalid/not-fetched.git' });
  const tokens = { alice: app.auth.createToken(alice.id, { name: 'Alice', scopes: ['read', 'write', 'review:local', 'review:hosted'] }).token, bob: app.auth.createToken(bob.id, { name: 'Bob', scopes: ['read', 'write', 'review:local', 'review:hosted'] }).token,
    reader: app.auth.createToken(alice.id, { name: 'Reader', scopes: ['read'] }).token };
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  async function request<T = ErrorBody>(path: string, method = 'GET', body?: unknown, actor: keyof typeof tokens = 'alice', key?: string) {
    const response = await fetch(origin + path, { method, signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${tokens[actor]}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as T };
  }
  function policy(id: string, changes: Record<string, unknown>, principal = bob.id) {
    const current = app.policies.policy(id, principal);
    return app.policies.setPolicy(id, { expectedVersion: current.version, spaceId: current.spaceId, ...current.rules, ...changes }, principal);
  }
  const evidence = () => Object.fromEntries(['entities', 'versions', 'activity', 'object_policies', 'policy_meta', 'idempotency', 'sequences'].map(table => [table, store.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  let closed = false;
  return { ...app, alice, bob, tokens, origin, request, policy, evidence, shutdown: app.close, close: async () => { if (closed) return; closed = true; await app.close(); store.close(); } };
}

test('Git imports atomically retain exact files, modes, attribution, source rules and Space, with immutable provenance across restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'git-import-store-')); const path = join(directory, 'workspace.sqlite');
  const app = await start({ databasePath: path });
  try {
    const space = app.policies.createSpace({ name: 'Source Space', view: workspace, edit: members(app.bob.id) }, app.bob.id);
    const policy = app.policy('R1', { spaceId: space.id, view: workspace, edit: members(app.alice.id, app.bob.id), interact: members(app.bob.id) });
    const imported = await app.request<RevisionDetail>(route, 'POST', input(), 'alice', 'first-import'); assert.equal(imported.status, 201, JSON.stringify(imported.body));
    const detail = imported.body; const version = detail.versions[0]!;
    assert.equal(detail.revision.repositoryId, 'R1'); assert.equal(detail.revision.status, 'needs_review'); assert.equal(detail.reviews.length, 0);
    assert.deepEqual(version.files, source); assert.equal(version.contentHash, contentHash(source)); assert.deepEqual(version.gitSource, snapshot().provenance);
    assert.equal(version.attribution?.principalId, app.alice.id); assert.equal(detail.activity[0]?.attribution?.principalId, app.alice.id);
    assert.deepEqual(detail.access!.policy.rules, policy.rules); assert.equal(detail.access!.policy.spaceId, space.id); assert.match(detail.access!.viewLabel, /linked repository view/);
    assert.equal((app.store.database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 14);
    const raw = app.store.database.prepare('SELECT data FROM versions WHERE id = ?').get(version.id);
    await app.close(); const reopened = createStore({ path });
    try { assert.deepEqual(reopened.detail(detail.revision.id).versions[0], version); assert.deepEqual(reopened.database.prepare('SELECT data FROM versions WHERE id = ?').get(version.id), raw); } finally { reopened.close(); }
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('ordinary uploads and suggestion applications never inherit or accept Git provenance', async () => {
  const app = await start();
  try {
    const imported = await app.request<RevisionDetail>(route, 'POST', { ...input(), kind: 'paper' }); assert.equal(imported.status, 201); const detail = imported.body; const id = detail.revision.id;
    for (const spoof of ['gitSource', 'provenance']) {
      assert.equal((await app.request('/api/revisions', 'POST', { kind: 'code', title: 'Spoofed', files: source, [spoof]: snapshot().provenance })).status, 400);
      assert.equal((await app.request(`/api/revisions/${id}/versions`, 'POST', { expectedVersion: 1, files: source, message: 'Spoofed', [spoof]: snapshot().provenance })).status, 400);
    }
    const root = await app.request<{ id: string }>(`/api/revisions/${id}/comments`, 'POST', { body: 'Clarify text', versionId: detail.versions[0]!.id, filePath: 'README.md', passage: { start: 1, end: 9, quote: 'Imported' }, suggestion: { replacement: 'Revised' } }); assert.equal(root.status, 201);
    const applied = await app.request<RevisionDetail>(`/api/revisions/${id}/suggestions/${root.body.id}/apply`, 'POST', { expectedVersion: 1, expectedVersionId: detail.versions[0]!.id, expectedContentHash: detail.versions[0]!.contentHash, expectedThreadVersion: 1 }); assert.equal(applied.status, 201, JSON.stringify(applied.body));
    assert.deepEqual(applied.body.versions[0]!.gitSource, snapshot().provenance); assert.equal(applied.body.versions[1]!.gitSource, undefined);
    const uploaded = await app.request<RevisionDetail>(`/api/revisions/${id}/versions`, 'POST', { expectedVersion: 2, files: source, message: 'Ordinary author upload' }); assert.equal(uploaded.status, 201); assert.equal(uploaded.body.versions[2]!.gitSource, undefined);
    assert.deepEqual(uploaded.body.versions[0]!.gitSource, snapshot().provenance);
  } finally { await app.close(); }
});

test('import authorization and strict metadata validation happen before Git and preserve source on failure', async () => {
  let calls = 0; const app = await start({ gitObserver: observer(async () => { calls++; return snapshot(); }) });
  try {
    const before = app.evidence();
    for (const extra of [{ files: source }, { source }, { access: { spaceId: 'S1' } }, { provenance: snapshot().provenance }, { gitSource: snapshot().provenance }, { repositoryId: 'R2' }, { commitId: 'main' }, { kind: 'other' }, { projectId: 'PROJ99999' }]) {
      assert.equal((await app.request(route, 'POST', { ...input(), ...extra })).status, 400);
    }
    assert.equal((await app.request(route, 'POST', input(), 'reader')).status, 403); assert.deepEqual(app.evidence(), before);
    app.policy('R1', { edit: members(app.bob.id) });
    assert.equal((await app.request(route, 'POST', input())).status, 403); assert.equal(calls, 0);
    app.policy('R1', { view: members(app.bob.id) });
    assert.deepEqual(await app.request(route, 'POST', input()), await app.request('/api/repositories/R999/import-revision', 'POST', input()));
    assert.equal(calls, 0);
  } finally { await app.close(); }
});

test('Git failure, invalid collector content and injected transaction failures commit no revision or replay', async () => {
  let result = snapshot(); let failure: Error | null = new HttpError(422, 'Unsupported tree.', 'GIT_IMPORT_UNSUPPORTED');
  const app = await start({ gitObserver: observer(async () => { if (failure) throw failure; return result; }) });
  try {
    const before = app.evidence();
    assert.equal((await app.request(route, 'POST', input(), 'alice', 'retry-failed-import')).status, 422); assert.deepEqual(app.evidence(), before);
    failure = null; result.files[0]!.content = 'Substituted source';
    assert.equal((await app.request(route, 'POST', input(), 'alice', 'retry-failed-import')).status, 422); assert.deepEqual(app.evidence(), before);
    result = snapshot(); app.store.database.exec("CREATE TRIGGER import_failure BEFORE INSERT ON activity WHEN NEW.object_id GLOB 'D*' BEGIN SELECT RAISE(ABORT, 'injected import failure'); END;");
    assert.equal((await app.request(route, 'POST', input(), 'alice', 'retry-failed-import')).status, 500); assert.deepEqual(app.evidence(), before);
    app.store.database.exec('DROP TRIGGER import_failure');
    assert.equal((await app.request(route, 'POST', input(), 'alice', 'retry-failed-import')).status, 201);
  } finally { await app.close(); }
});

test('a saved import retries without Git but checks created revision authority and preserves its historical response bytes', async () => {
  let calls = 0; let unavailable = false;
  const app = await start({ gitObserver: observer(async () => { calls++; if (unavailable) throw new HttpError(503, 'Git removed.', 'GIT_UNAVAILABLE'); return snapshot(); }) });
  try {
    const first = await app.request<RevisionDetail>(route, 'POST', input(), 'alice', 'stable-import'); assert.equal(first.status, 201); unavailable = true;
    const stored = app.store.database.prepare('SELECT body FROM idempotency').all();
    const replay = await app.request<RevisionDetail>(route, 'POST', input(), 'alice', 'stable-import'); assert.equal(replay.status, 201); assert.equal(calls, 1); assert.deepEqual(replay.body.versions, first.body.versions);
    assert.equal((await app.request(route, 'POST', input('Changed'), 'alice', 'stable-import')).status, 409); assert.equal(calls, 1);
    app.policy(first.body.revision.id, { view: members(app.bob.id), edit: members(app.bob.id) });
    const hidden = await app.request(route, 'POST', input(), 'alice', 'stable-import'); assert.equal(hidden.status, 404); assert.equal(hidden.body.code, 'REVISION_REFERENCE_UNAVAILABLE'); assert.equal((await app.request('/api/repositories/R1')).status, 200);
    app.policy(first.body.revision.id, { view: workspace }); assert.equal((await app.request(route, 'POST', input(), 'alice', 'stable-import')).status, 403);
    app.policy(first.body.revision.id, { edit: workspace }); assert.equal((await app.request(route, 'POST', input(), 'alice', 'stable-import')).status, 201);
    assert.equal(calls, 1); assert.deepEqual(app.store.database.prepare('SELECT body FROM idempotency').all(), stored);
  } finally { await app.close(); }
});

test('repository visibility gates every linked revision surface and capability, including old unprovenanced versions', async () => {
  const app = await start();
  try {
    const imported = (await app.request<RevisionDetail>(route, 'POST', input(), 'alice', 'gated-import')).body;
    const legacy = app.store.createRevision({ kind: 'code', title: 'Earlier linked source', repositoryId: 'R1', files: source });
    assert.equal(legacy.versions[0]!.gitSource, undefined);
    app.policy('R1', { view: members(app.bob.id), edit: members(app.bob.id) });
    for (const detail of [imported, legacy]) {
      const id = detail.revision.id;
      assert.deepEqual(app.policies.access(id, app.alice.id), { view: false, edit: false, interact: false, managePolicy: false });
      for (const path of [`/api/revisions/${id}`, `/api/revisions/${id}/export`, `/api/policies/${id}`]) assert.equal((await app.request(path)).status, 404, path);
      for (const [path, body] of [[`/api/revisions/${id}/versions`, { expectedVersion: 1, files: source, message: 'Unauthorized' }], [`/api/revisions/${id}/comments`, { versionId: detail.versions[0]!.id, body: 'Unauthorized' }], [`/api/revisions/${id}/reviews`, { expectedVersion: 1, provider: 'local' }]] as const) assert.equal((await app.request(path, 'POST', body)).status, 404);
    }
    const state = (await app.request<AppState>('/api/state')).body; assert.equal(state.revisions.length, 0); assert.ok(!state.activity.some(event => [imported.revision.id, legacy.revision.id].includes(event.objectId))); assert.ok(!JSON.stringify(state).includes('Imported text'));
    assert.equal((await app.request(route, 'POST', input(), 'alice', 'gated-import')).status, 404);
    app.policy('R1', { view: workspace, edit: workspace });
    assert.equal((await app.request(`/api/revisions/${legacy.revision.id}`)).status, 200);
    const sourceSpace = app.policies.createSpace({ name: 'Source boundary', view: workspace, edit: members(app.bob.id) }, app.bob.id);
    app.policy('R1', { spaceId: sourceSpace.id });
    assert.equal(app.policies.policy(imported.revision.id, app.alice.id).spaceId, 'S1');
    app.policies.updateSpace(sourceSpace.id, { expectedVersion: sourceSpace.version, view: members(app.bob.id) }, app.bob.id);
    for (const detail of [imported, legacy]) assert.equal((await app.request(`/api/revisions/${detail.revision.id}/export`)).status, 404);
    app.policy('R1', { spaceId: 'S1' });
    for (const dependency of [undefined, 42, {}, 'PROJ1', 'R99999']) {
      app.store.database.prepare('UPDATE entities SET data = ? WHERE id = ?').run(JSON.stringify({ ...legacy.revision, repositoryId: dependency }), legacy.revision.id);
      assert.equal(app.policies.access(legacy.revision.id, app.alice.id).view, false);
    }
  } finally { await app.close(); }
});

test('pending imports use current source policy and reject revocation or Git failure after the asynchronous read', async () => {
  let gate = deferred<GitImportSnapshot>(); let entered = deferred<void>();
  const app = await start({ gitObserver: observer(async () => { entered.resolve(); return gate.promise; }) });
  try {
    const pending = app.request<RevisionDetail>(route, 'POST', input(), 'alice', 'pending-policy'); await entered.promise;
    assert.doesNotThrow(() => app.store.database.exec('BEGIN IMMEDIATE; ROLLBACK;'));
    const current = app.policy('R1', { view: members(app.alice.id, app.bob.id), interact: members(app.bob.id) }); gate.resolve(snapshot());
    const saved = await pending; assert.equal(saved.status, 201); assert.deepEqual(saved.body.access!.policy.rules, current.rules);
    gate = deferred<GitImportSnapshot>(); entered = deferred<void>(); const denied = app.request(route, 'POST', input('Second'), 'alice', 'pending-revoked'); await entered.promise;
    app.policy('R1', { view: members(app.bob.id), edit: members(app.bob.id) }); const before = app.evidence();
    gate.reject(new HttpError(422, 'Sensitive source error', 'GIT_IMPORT_UNSUPPORTED'));
    const failed = await denied; assert.equal(failed.status, 404); assert.equal(failed.body.code, 'OBJECT_UNAVAILABLE'); assert.ok(!failed.body.error.includes('Sensitive')); assert.deepEqual(app.evidence(), before);
  } finally { await app.close(); }
});

test('repository revocation during AI review rejects evidence and sanitizes both successful and failed providers', { timeout: 15_000 }, async () => {
  let gate = deferred<ReviewAnalysis>(); let entered = deferred<void>();
  const app = await start({ aiConfiguration: () => ({ configured: false, model: null, localConfigured: true, localModel: 'local fixture' }), analyzeAI: async () => { entered.resolve(); return gate.promise; } });
  try {
    const detail = (await app.request<RevisionDetail>(route, 'POST', input())).body;
    for (const fails of [false, true]) {
      gate = deferred<ReviewAnalysis>(); entered = deferred<void>();
      const pending = app.request(`/api/revisions/${detail.revision.id}/reviews`, 'POST', { expectedVersion: 1, provider: 'ollama' }, 'alice', `review-${fails}`); await entered.promise;
      app.policy('R1', { view: members(app.bob.id), edit: members(app.bob.id) });
      if (fails) gate.reject(new HttpError(502, 'Sensitive provider failure')); else gate.resolve({ provider: 'ollama', model: 'local fixture', summary: 'Review source', findings: [] });
      assert.equal((await pending).status, 404); assert.equal(app.store.detail(detail.revision.id).reviews.length, 0);
      app.policy('R1', { view: workspace, edit: workspace });
    }
  } finally { await app.close(); }
});

test('the real Git collector imports one complete pinned text tree and rejects unsupported trees without partial writes', async () => {
  const fixture = await createGitFixture(); const app = await start({ gitObserver: createGitObserver({ R1: fixture.barePath }) });
  try {
    const result = await app.request<RevisionDetail>(route, 'POST', { ...input(), commitId: fixture.importCommit, kind: 'document' }); assert.equal(result.status, 201, JSON.stringify(result.body));
    const version = result.body.versions[0]!; assert.equal(version.gitSource?.commitId, fixture.importCommit); assert.equal(version.gitSource?.scope, 'complete-text-tree'); assert.equal(result.body.revision.kind, 'document');
    const before = app.evidence();
    assert.equal((await app.request(route, 'POST', { ...input(), commitId: fixture.head }, 'alice', 'unsupported-tree')).status, 422); assert.deepEqual(app.evidence(), before);
  } finally { await app.close(); await fixture.close(); }
});

test('pending imports recheck credential, selected project and source Space authority before writing', { timeout: 20_000 }, async () => {
  let gate = deferred<GitImportSnapshot>(); let entered = deferred<void>();
  let calls = 0; const app = await start({ gitObserver: observer(async () => { calls++; entered.resolve(); return gate.promise; }) });
  try {
    const project = app.store.createProject({ name: 'Selected project' });
    const body = { ...input(), projectId: project.id };
    const first = app.request(route, 'POST', body, 'alice', 'credential-change'); await entered.promise;
    app.auth.setAccountDisabled(app.alice.id, true); gate.resolve(snapshot()); assert.equal((await first).status, 401);
    app.auth.setAccountDisabled(app.alice.id, false);
    // Disabling revokes credentials, so issue the operator's replacement token.
    app.tokens.alice = app.auth.createToken(app.alice.id, { name: 'Restored', scopes: ['read', 'write'] }).token;
    gate = deferred<GitImportSnapshot>(); entered = deferred<void>(); const second = app.request(route, 'POST', body, 'alice', 'project-change'); await entered.promise;
    app.policy(project.id, { view: members(app.bob.id), edit: members(app.bob.id) }); gate.resolve(snapshot());
    assert.equal((await second).status, 400);
    const space = app.policies.createSpace({ name: 'Repository Space', view: workspace, edit: members(app.bob.id) }, app.bob.id);
    app.policy('R1', { spaceId: space.id });
    gate = deferred<GitImportSnapshot>(); entered = deferred<void>(); const third = app.request(route, 'POST', input(), 'alice', 'space-change'); await entered.promise;
    app.policies.updateSpace(space.id, { expectedVersion: space.version, view: members(app.bob.id) }, app.bob.id); gate.resolve(snapshot()); assert.equal((await third).status, 404);
    assert.equal(calls, 3); assert.equal(app.store.database.prepare("SELECT COUNT(*) AS count FROM entities WHERE kind='revision'").get()!.count, 0); assert.equal(app.store.database.prepare('SELECT COUNT(*) AS count FROM idempotency').get()!.count, 0);
  } finally { await app.close(); }
});

test('competing writer revocation blocks fresh Git imports and newly visible saved retries under the final lock', { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'git-import-lock-')); const databasePath = join(directory, 'workspace.sqlite');
  const app = await start({ databasePath }); const transaction = app.store.transaction.bind(app.store);
  try {
    for (const phase of ['fresh', 'replay'] as const) {
      app.policy('R1', { view: workspace, edit: workspace });
      const key = `lock-${phase}`; const body = input(phase);
      let replay: { key: string; fingerprint: string; status: number; body: string; created_at: string } | undefined;
      let protectedId = 'R1';
      if (phase === 'replay') {
        const created = await app.request<RevisionDetail>(route, 'POST', body, 'alice', key); assert.equal(created.status, 201); protectedId = created.body.revision.id;
        replay = app.store.database.prepare('SELECT * FROM idempotency ORDER BY created_at DESC LIMIT 1').get() as typeof replay; assert.ok(replay);
        app.store.database.prepare('DELETE FROM idempotency WHERE key = ?').run(replay.key);
      }
      const policy = app.policies.policy(protectedId, app.bob.id);
      const restricted = { ...policy, version: policy.version + 1, rules: { view: members(app.bob.id), edit: members(app.bob.id), interact: members(app.bob.id) } };
      const before = app.store.database.prepare('SELECT * FROM versions').all(); const activity = app.store.activities();
      const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(`
        import { parentPort, workerData } from 'node:worker_threads'; import { DatabaseSync } from 'node:sqlite';
        const db = new DatabaseSync(workerData.databasePath); db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
        db.prepare('UPDATE object_policies SET data=? WHERE object_id=?').run(JSON.stringify(workerData.policy), workerData.policy.objectId);
        db.prepare("UPDATE policy_meta SET value=value+1 WHERE name='epoch'").run();
        if(workerData.replay){const r=workerData.replay;db.prepare('INSERT INTO idempotency (key,fingerprint,status,body,created_at) VALUES (?,?,?,?,?)').run(r.key,r.fingerprint,r.status,r.body,r.created_at);}
        parentPort.once('message',()=>{db.exec('COMMIT');db.close();parentPort.close();});parentPort.postMessage('locked');
      `)}`), { workerData: { databasePath, policy: restricted, replay } });
      try {
        assert.deepEqual(await once(worker, 'message'), ['locked']); let locked = 0;
        app.store.transaction = function<T>(work: () => T): T { locked++; app.store.transaction = transaction; worker.postMessage('commit'); return transaction(work); };
        const denied = await app.request(route, 'POST', body, 'alice', key); assert.equal(locked, 1); assert.equal(denied.status, 404);
        assert.equal(denied.body.code, phase === 'fresh' ? 'OBJECT_UNAVAILABLE' : 'REVISION_REFERENCE_UNAVAILABLE');
        assert.deepEqual(app.store.database.prepare('SELECT * FROM versions').all(), before); assert.deepEqual(app.store.activities(), activity);
        if (replay) assert.equal(app.store.database.prepare('SELECT body FROM idempotency WHERE key=?').get(replay.key)!.body, replay.body);
      } finally { app.store.transaction = transaction; await worker.terminate(); }
    }
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('concurrent exact imports collect once, and disconnect or shutdown cancels without writes', { timeout: 20_000 }, async () => {
  let gate = deferred<GitImportSnapshot>(); let entered = deferred<AbortSignal>(); let calls = 0;
  const app = await start({ gitObserver: observer(async (_id, _commit, signal) => { assert.ok(signal); calls++; entered.resolve(signal); return gate.promise; }) });
  try {
    const first = app.request<RevisionDetail>(route, 'POST', input(), 'alice', 'same-import'); await entered.promise;
    const second = app.request<RevisionDetail>(route, 'POST', input(), 'alice', 'same-import'); gate.resolve(snapshot());
    const [a, b] = await Promise.all([first, second]); assert.equal(a.status, 201); assert.equal(b.status, 201); assert.equal(a.body.revision.id, b.body.revision.id); assert.equal(calls, 1);
    const before = app.evidence(); gate = deferred<GitImportSnapshot>(); entered = deferred<AbortSignal>();
    const controller = new AbortController(); const canceled = fetch(app.origin + route, { method: 'POST', signal: controller.signal, headers: { Authorization: `Bearer ${app.tokens.alice}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'disconnect' }, body: JSON.stringify(input('Disconnect')) });
    const cancellation = assert.rejects(canceled); const signal = await entered.promise; const aborted = once(signal, 'abort'); controller.abort(); await cancellation; await aborted; gate.resolve(snapshot());
    entered = deferred<AbortSignal>(); gate = deferred<GitImportSnapshot>(); const closing = app.request(route, 'POST', input('Shutdown'), 'alice', 'shutdown'); const shutdownSignal = await entered.promise;
    await app.shutdown(); assert.equal(shutdownSignal.aborted, true); assert.equal((await closing).body.code, 'GIT_ABORTED');
    assert.deepEqual(app.evidence(), before);
  } finally { await app.close(); }
});
