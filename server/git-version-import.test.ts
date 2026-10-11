import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import type { AddressInfo } from 'node:net';
import { createApp, type AppOptions } from './app.ts';
import { createStore, contentHash } from './store.ts';
import { createAuth } from './auth.ts';
import { createGitObserver, type GitObserver } from './git.ts';
import { HttpError } from './validation.ts';
import { createGitFixture } from '../tests/git-fixture.ts';
import type { GitImportSnapshot, GitVersionImportInput } from '../shared/repositories.ts';
import type { RevisionDetail, RevisionKind, SourceFile } from '../shared/types.ts';

const commitId = 'a'.repeat(40); const treeId = 'b'.repeat(40);
const source = [{ path: 'README.md', content: '\ufeffReplacement text.\n' }, { path: 'run.sh', content: '#!/bin/sh\nexit 0\n' }];
function snapshot(commit = commitId, files: SourceFile[] = source): GitImportSnapshot {
  return { repositoryId: 'R1', objectFormat: 'sha1', files: structuredClone(files), provenance: { kind: 'git', repositoryId: 'R1', objectFormat: 'sha1', commitId: commit, treeId, scope: 'complete-text-tree', manifest: files.map((file, index) => ({ path: file.path, mode: index ? '100755' : '100644', objectId: createHash('sha1').update(`blob ${Buffer.byteLength(file.content)}\0`).update(file.content).digest('hex') })) } };
}
const route = (id: string) => `/api/revisions/${id}/import-git`;
const members = (...principalIds: string[]) => ({ kind: 'principals' as const, principalIds });
const workspace = { kind: 'workspace' as const };
type ErrorBody = { error: string; code?: string };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function observer(importSnapshot: GitObserver['importSnapshot'] = async (_id, commit) => snapshot(commit)): GitObserver {
  const unavailable = async (): Promise<never> => { throw new HttpError(503, 'Fixture read unavailable.', 'GIT_UNAVAILABLE'); };
  return { importSnapshot, info: async () => ({ state: 'ready', objectFormat: 'sha1' }), refs: unavailable, commit: unavailable, tree: unavailable, blob: unavailable, history: unavailable };
}
function input(detail: RevisionDetail, commit = commitId): GitVersionImportInput {
  const version = detail.versions.find(item => item.number === detail.revision.currentVersion)!;
  return { commitId: commit, expectedVersion: version.number, expectedVersionId: version.id, expectedContentHash: version.contentHash, message: 'Import the complete pinned tree' };
}
async function start(options: AppOptions = {}) {
  const store = createStore({ path: options.databasePath ?? ':memory:' });
  const provision = createAuth({ database: store.database, mode: 'local', basePath: '/', provisioning: true });
  const alice = await provision.createAccount({ username: 'alice', displayName: 'Alice', password: 'Alice pinned version import password' });
  const bob = await provision.createAccount({ username: 'bob', displayName: 'Bob', password: 'Bob pinned version import password' });
  const app = createApp({ ...options, store, seed: false, authMode: 'password', gitObserver: options.gitObserver ?? observer() });
  store.createRepository({ name: 'Git source', remoteUrl: 'https://example.invalid/not-fetched.git' });
  store.createRepository({ name: 'Other source', remoteUrl: 'https://example.invalid/also-not-fetched.git' });
  const tokens = { alice: app.auth.createToken(alice.id, { name: 'Alice', scopes: ['read', 'write'] }).token, bob: app.auth.createToken(bob.id, { name: 'Bob', scopes: ['read', 'write'] }).token, reader: app.auth.createToken(alice.id, { name: 'Reader', scopes: ['read'] }).token };
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  async function request<T = ErrorBody>(path: string, method = 'GET', body?: unknown, actor: keyof typeof tokens = 'alice', key?: string) {
    const response = await fetch(origin + path, { method, signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${tokens[actor]}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as T };
  }
  function policy(id: string, changes: Record<string, unknown>) {
    const current = app.policies.policy(id, bob.id);
    return app.policies.setPolicy(id, { expectedVersion: current.version, spaceId: current.spaceId, ...current.rules, ...changes }, bob.id);
  }
  const create = (kind: RevisionKind = 'code', repositoryId: string | null = 'R1') => store.createRevision({ kind, repositoryId, title: 'Existing review', summary: 'Keep my metadata', files: [{ path: 'old.txt', content: 'Original source\n' }] });
  const rows = (table: string) => store.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
  const evidence = () => Object.fromEntries(['entities', 'versions', 'comments', 'review_threads', 'thread_events', 'suggestion_applications', 'reviews', 'activity', 'object_policies', 'policy_meta', 'idempotency', 'sequences'].map(table => [table, rows(table)]));
  let closed = false;
  return { ...app, alice, bob, tokens, origin, request, policy, create, rows, evidence, shutdown: app.close, close: async () => { if (closed) return; closed = true; await app.close(); store.close(); } };
}

test('a source viewer can append Git provenance to an editable review without changing policy, metadata or earlier evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'git-version-')); const databasePath = join(directory, 'workspace.sqlite'); const app = await start({ databasePath });
  try {
    const initial = app.create(); const id = initial.revision.id; const version = initial.versions[0]!;
    const comment = app.store.createComment(id, { body: 'Retain this proposal', versionId: version.id, filePath: 'old.txt', passage: { start: 0, end: 8, quote: 'Original' }, suggestion: { replacement: 'Earlier' } });
    app.store.updateThread(id, comment.id, { status: 'resolved', expectedThreadVersion: 1, versionId: version.id });
    app.store.saveReview(id, 1, { provider: 'local', model: 'deterministic-checks', summary: 'Old evidence', findings: [] });
    app.store.updateRevision(id, { status: 'accepted', expectedVersion: 1 });
    const ownSpace = app.policies.createSpace({ name: 'Review Space', view: members(app.alice.id, app.bob.id), edit: members(app.bob.id) }, app.bob.id);
    app.policy(id, { spaceId: ownSpace.id, view: members(app.alice.id, app.bob.id), edit: members(app.alice.id, app.bob.id), interact: members(app.bob.id) });
    app.policy('R1', { edit: members(app.bob.id) });
    assert.equal(app.policies.access('R1', app.alice.id).edit, false);
    const before = app.evidence(); const old = app.store.detail(id);
    const saved = await app.request<RevisionDetail>(route(id), 'POST', input(old), 'alice', 'append'); assert.equal(saved.status, 201, JSON.stringify(saved.body));
    const detail = saved.body; const imported = detail.versions[1]!;
    assert.equal(detail.revision.currentVersion, 2); assert.equal(detail.revision.status, 'needs_review');
    const stable = ({ currentVersion: _version, status: _status, updatedAt: _updated, ...metadata }: RevisionDetail['revision']) => metadata;
    assert.deepEqual(stable(detail.revision), stable(old.revision)); assert.deepEqual(imported.files, source); assert.equal(imported.contentHash, contentHash(source)); assert.deepEqual(imported.gitSource, snapshot().provenance);
    assert.equal(imported.attribution?.principalId, app.alice.id); assert.equal(imported.message, input(old).message); assert.equal(detail.activity[0]?.attribution?.principalId, app.alice.id);
    for (const table of ['comments', 'review_threads', 'thread_events', 'suggestion_applications', 'reviews', 'object_policies', 'policy_meta']) assert.deepEqual(app.rows(table), before[table], table);
    assert.deepEqual(app.rows('versions').slice(0, 1), before.versions); assert.deepEqual(detail.versions[0], old.versions[0]); assert.equal(detail.threads[0]!.status, 'resolved');
    assert.equal((await app.request(`/api/revisions/${id}`, 'PATCH', { status: 'accepted', expectedVersion: 2 })).status, 409);
    assert.equal((await app.request(`/api/revisions/${id}/suggestions/${comment.id}/apply`, 'POST', { expectedVersion: 2, expectedVersionId: imported.id, expectedContentHash: imported.contentHash, expectedThreadVersion: 2 })).status, 409);
    const raw = app.rows('versions'); await app.close(); const reopened = createStore({ path: databasePath });
    try { assert.deepEqual(reopened.database.prepare('SELECT * FROM versions ORDER BY rowid').all(), raw); assert.deepEqual(reopened.detail(id).versions[1], imported); } finally { reopened.close(); }
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('strict pins and server-only source reject malformed, stale, unlinked and forged requests before collection', async () => {
  let calls = 0; const app = await start({ gitObserver: observer(async () => { calls++; return snapshot(); }) });
  try {
    const detail = app.create(); const initial = input(detail); const before = app.evidence();
    for (const patch of [{ files: source }, { repositoryId: 'R2' }, { access: { spaceId: 'S1' } }, { provenance: snapshot().provenance }, { gitSource: snapshot().provenance }, { title: 'Replacement' }, { kind: 'paper' }, { commitId: 'main' }, { expectedVersion: 0 }, { expectedVersionId: '' }, { expectedContentHash: 'x'.repeat(64) }, { message: '' }, { message: 'x'.repeat(10_001) }]) assert.equal((await app.request(route(detail.revision.id), 'POST', { ...initial, ...patch })).status, 400);
    for (const patch of [{ expectedVersion: 2 }, { expectedVersionId: 'another-version' }, { expectedContentHash: 'f'.repeat(64) }]) assert.equal((await app.request(route(detail.revision.id), 'POST', { ...initial, ...patch })).status, 409);
    assert.equal((await app.request(route(detail.revision.id), 'POST', initial, 'reader')).status, 403); assert.equal(calls, 0); assert.deepEqual(app.evidence(), before);
    const unlinked = app.create('paper', null); const denied = await app.request(route(unlinked.revision.id), 'POST', input(unlinked)); assert.equal(denied.status, 400); assert.equal(denied.body.code, 'GIT_IMPORT_UNLINKED'); assert.equal(calls, 0);
    app.store.database.prepare('UPDATE versions SET data=? WHERE id=?').run(JSON.stringify({ ...detail.versions[0], files: source }), detail.versions[0]!.id);
    assert.equal((await app.request(route(detail.revision.id), 'POST', initial)).status, 409); assert.equal(calls, 0);
  } finally { await app.close(); }
});

test('fresh import creates distinct evidence for identical or older source, while ordinary later edits drop only their own Git provenance', async () => {
  const app = await start();
  try {
    for (const kind of ['code', 'paper', 'document'] as const) {
      const initial = app.create(kind); const id = initial.revision.id;
      const first = await app.request<RevisionDetail>(route(id), 'POST', input(initial)); assert.equal(first.status, 201);
      const repeated = await app.request<RevisionDetail>(route(id), 'POST', input(first.body)); assert.equal(repeated.status, 201); assert.equal(repeated.body.revision.currentVersion, 3);
      assert.notEqual(repeated.body.versions[1]!.id, repeated.body.versions[2]!.id); assert.equal(repeated.body.versions[1]!.contentHash, repeated.body.versions[2]!.contentHash);
      const uploaded = await app.request<RevisionDetail>(`/api/revisions/${id}/versions`, 'POST', { expectedVersion: 3, message: 'Manual edit', files: [{ path: 'local.txt', content: 'Local revision' }] }); assert.equal(uploaded.status, 201); assert.equal(uploaded.body.versions[3]!.gitSource, undefined);
      const restored = await app.request<RevisionDetail>(route(id), 'POST', input(uploaded.body, 'c'.repeat(40))); assert.equal(restored.status, 201); assert.equal(restored.body.versions[4]!.gitSource?.commitId, 'c'.repeat(40)); assert.deepEqual(restored.body.versions.slice(0, 4), uploaded.body.versions);
    }
  } finally { await app.close(); }
});

test('saved version imports bypass changed head and unavailable Git but recheck target edit and source view', async () => {
  let calls = 0; let fail = false; const app = await start({ gitObserver: observer(async () => { calls++; if (fail) throw new HttpError(503, 'Git unavailable'); return snapshot(); }) });
  try {
    const initial = app.create(); const id = initial.revision.id; const body = input(initial); const first = await app.request<RevisionDetail>(route(id), 'POST', body, 'alice', 'saved-version'); assert.equal(first.status, 201);
    app.store.createVersion(id, { expectedVersion: 2, files: source, message: 'A later upload' }); fail = true;
    const evidence = app.evidence(); const replay = await app.request<RevisionDetail>(route(id), 'POST', body, 'alice', 'saved-version'); assert.equal(replay.status, 201); assert.equal(replay.body.revision.currentVersion, 2); assert.deepEqual(replay.body.versions, first.body.versions); assert.deepEqual(app.evidence(), evidence); assert.equal(calls, 1);
    assert.equal((await app.request(route(id), 'POST', { ...body, message: 'Changed' }, 'alice', 'saved-version')).status, 409);
    app.policy(id, { edit: members(app.bob.id) }); assert.equal((await app.request(route(id), 'POST', body, 'alice', 'saved-version')).status, 403);
    app.policy(id, { edit: workspace }); app.policy('R1', { view: members(app.bob.id), edit: members(app.bob.id) });
    const hidden = await app.request(route(id), 'POST', body, 'alice', 'saved-version'); assert.equal(hidden.status, 404); assert.equal(hidden.body.code, 'OBJECT_UNAVAILABLE');
    app.policy('R1', { view: workspace }); assert.equal((await app.request(route(id), 'POST', body, 'alice', 'saved-version')).status, 201); assert.equal(calls, 1);
    assert.deepEqual(app.rows('idempotency'), evidence.idempotency);
  } finally { await app.close(); }
});

test('a concurrent upload wins over an outstanding Git import, while exact concurrent retries collect and append only once', { timeout: 20_000 }, async () => {
  let gate = deferred<GitImportSnapshot>(); let entered = deferred<void>(); let calls = 0;
  const app = await start({ gitObserver: observer(async () => { calls++; entered.resolve(); return gate.promise; }) });
  try {
    const initial = app.create(); const id = initial.revision.id; const pending = app.request(route(id), 'POST', input(initial), 'alice', 'stale-git'); await entered.promise;
    assert.doesNotThrow(() => app.store.database.exec('BEGIN IMMEDIATE; ROLLBACK;'));
    app.store.createVersion(id, { expectedVersion: 1, files: [{ path: 'newer.txt', content: 'Concurrent source' }], message: 'Concurrent upload' }); const before = app.evidence(); gate.resolve(snapshot());
    assert.equal((await pending).status, 409); assert.deepEqual(app.evidence(), before);
    gate = deferred<GitImportSnapshot>(); entered = deferred<void>(); const body = input(app.store.detail(id));
    const first = app.request<RevisionDetail>(route(id), 'POST', body, 'alice', 'same'); await entered.promise; const second = app.request<RevisionDetail>(route(id), 'POST', body, 'alice', 'same'); gate.resolve(snapshot());
    const [a, b] = await Promise.all([first, second]); assert.equal(a.status, 201); assert.equal(b.status, 201); assert.equal(a.body.versions[2]!.id, b.body.versions[2]!.id); assert.equal(calls, 2); assert.equal(app.store.detail(id).versions.length, 3);
  } finally { await app.close(); }
});

test('pending Git successes and failures recheck target, source, Space and credential authority without saving source', { timeout: 20_000 }, async () => {
  let gate = deferred<GitImportSnapshot>(); let entered = deferred<void>();
  const app = await start({ gitObserver: observer(async () => { entered.resolve(); return gate.promise; }) });
  try {
    const initial = app.create(); const id = initial.revision.id;
    for (const change of ['target', 'source', 'space', 'credential'] as const) {
      gate = deferred<GitImportSnapshot>(); entered = deferred<void>(); const pending = app.request(route(id), 'POST', input(initial), 'alice', change); await entered.promise;
      if (change === 'target') app.policy(id, { edit: members(app.bob.id) });
      if (change === 'source') app.policy('R1', { view: members(app.bob.id), edit: members(app.bob.id) });
      if (change === 'space') { const space = app.policies.createSpace({ name: 'Source restricted', view: members(app.bob.id), edit: members(app.bob.id) }, app.bob.id); app.policy('R1', { spaceId: space.id }); }
      if (change === 'credential') app.auth.setAccountDisabled(app.alice.id, true);
      const before = app.evidence(); if (change === 'source' || change === 'credential') gate.reject(new Error('Sensitive Git source failure')); else gate.resolve(snapshot());
      const denied = await pending; assert.equal(denied.status, change === 'target' ? 403 : change === 'credential' ? 401 : 404); assert.ok(!denied.body.error.includes('Sensitive')); assert.deepEqual(app.evidence(), before);
      if (change === 'target') app.policy(id, { edit: workspace });
      if (change === 'source') app.policy('R1', { view: workspace });
      if (change === 'space') app.policy('R1', { spaceId: 'S1' });
    }
  } finally { await app.close(); }
});

test('collector identity, integrity and transactional failures preserve the entire existing review and allow a safe retry', async () => {
  let result = snapshot(); const app = await start({ gitObserver: observer(async () => result) });
  try {
    const initial = app.create(); const id = initial.revision.id; const body = input(initial); const before = app.evidence();
    result.files[0]!.content = 'Tampered'; assert.equal((await app.request(route(id), 'POST', body, 'alice', 'failure')).status, 422); assert.deepEqual(app.evidence(), before);
    result = snapshot(); result.repositoryId = 'R2'; assert.equal((await app.request(route(id), 'POST', body, 'alice', 'failure')).status, 422); assert.deepEqual(app.evidence(), before);
    result = snapshot(); result.provenance.commitId = 'd'.repeat(40); assert.equal((await app.request(route(id), 'POST', body, 'alice', 'failure')).status, 422); assert.deepEqual(app.evidence(), before);
    result = snapshot(); app.store.database.exec("CREATE TRIGGER version_import_failure BEFORE INSERT ON activity WHEN NEW.object_id GLOB 'D*' BEGIN SELECT RAISE(ABORT, 'injected import failure'); END;");
    assert.equal((await app.request(route(id), 'POST', body, 'alice', 'failure')).status, 500); assert.deepEqual(app.evidence(), before); app.store.database.exec('DROP TRIGGER version_import_failure');
    assert.equal((await app.request(route(id), 'POST', body, 'alice', 'failure')).status, 201);
  } finally { await app.close(); }
});

test('a repository association changed during collection cannot retarget either genuine or forged collector output', { timeout: 10_000 }, async () => {
  let gate = deferred<GitImportSnapshot>(); let entered = deferred<void>(); const app = await start({ gitObserver: observer(async () => { entered.resolve(); return gate.promise; }) });
  try {
    for (const forged of [false, true]) {
      gate = deferred<GitImportSnapshot>(); entered = deferred<void>();
      const initial = app.create(); const pending = app.request(route(initial.revision.id), 'POST', input(initial), 'alice', `link-${forged}`); await entered.promise;
      // There is no public reassignment endpoint. Simulate a future/operator
      // write and prove even forged output cannot replace the captured source.
      app.store.database.prepare('UPDATE entities SET data=? WHERE id=?').run(JSON.stringify({ ...initial.revision, repositoryId: 'R2' }), initial.revision.id);
      const before = app.evidence(); const result = snapshot();
      if (forged) { result.repositoryId = 'R2'; result.provenance.repositoryId = 'R2'; }
      gate.resolve(result); assert.equal((await pending).status, forged ? 422 : 409); assert.deepEqual(app.evidence(), before);
    }
  } finally { await app.close(); }
});

test('real Git imports preserve exact successive, equal-tree and older commits and reject unsupported trees atomically', async () => {
  const fixture = await createGitFixture(); const app = await start({ gitObserver: createGitObserver({ R1: fixture.barePath }) });
  try {
    let detail = app.create('paper'); const id = detail.revision.id;
    for (const commit of [fixture.importCommit, fixture.importNextCommit, fixture.importEqualCommit, fixture.base]) {
      const oldVersions = detail.versions; const saved = await app.request<RevisionDetail>(route(id), 'POST', input(detail, commit)); assert.equal(saved.status, 201, JSON.stringify(saved.body)); detail = saved.body;
      const version = detail.versions.at(-1)!; assert.equal(version.gitSource?.commitId, commit); assert.deepEqual(detail.versions.slice(0, -1), oldVersions); assert.equal(version.contentHash, contentHash(version.files));
    }
    assert.deepEqual(detail.versions[1]!.files, detail.versions[3]!.files); assert.notEqual(detail.versions[1]!.gitSource?.commitId, detail.versions[3]!.gitSource?.commitId);
    assert.equal(detail.versions[2]!.gitSource!.manifest.find(file => file.path === 'tools/check.sh')!.mode, '100644');
    assert.equal(detail.versions[2]!.files.some(file => file.path === 'name with spaces.md'), false); assert.equal(detail.versions.at(-1)!.files.length, 1);
    const before = app.evidence(); assert.equal((await app.request(route(id), 'POST', input(detail, fixture.head), 'alice', 'unsupported')).status, 422); assert.deepEqual(app.evidence(), before);
  } finally { await app.close(); await fixture.close(); }
});

test('competing writer revocations block fresh and newly visible saved version imports after acquiring the lock', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'git-version-lock-')); const databasePath = join(directory, 'workspace.sqlite'); const app = await start({ databasePath }); const transaction = app.store.transaction.bind(app.store);
  try {
    for (const reference of ['source', 'target'] as const) for (const phase of ['fresh', 'replay'] as const) {
      app.policy('R1', { view: workspace, edit: workspace });
      const initial = app.create(); const id = initial.revision.id; const body = input(initial); const key = `${reference}-${phase}`;
      let replay: { key: string; fingerprint: string; status: number; body: string; created_at: string } | undefined;
      let committed: { entity: Record<string, unknown>; version: Record<string, unknown>; activity: Record<string, unknown> } | undefined;
      if (phase === 'replay') {
        assert.equal((await app.request(route(id), 'POST', body, 'alice', key)).status, 201);
        replay = app.store.database.prepare('SELECT * FROM idempotency ORDER BY created_at DESC LIMIT 1').get() as typeof replay; assert.ok(replay); app.store.database.prepare('DELETE FROM idempotency WHERE key=?').run(replay.key);
        committed = { entity: app.store.database.prepare('SELECT * FROM entities WHERE id=?').get(id)!, version: app.store.database.prepare('SELECT * FROM versions WHERE revision_id=? AND number=2').get(id)!, activity: app.store.database.prepare('SELECT * FROM activity WHERE object_id=? ORDER BY sequence DESC LIMIT 1').get(id)! };
      }
      const current = app.policies.policy(reference === 'source' ? 'R1' : id, app.bob.id);
      const policy = { ...current, version: current.version + 1, rules: { ...current.rules, ...(reference === 'source' ? { view: members(app.bob.id) } : {}), edit: members(app.bob.id) } };
      const before = app.store.detail(id); const versions = app.rows('versions'); const activity = app.rows('activity');
      if (committed) {
        // Rewind this disposable fixture to the genuinely uncommitted base.
        // The competing writer publishes head, version, event and receipt
        // together, so HTTP preflight still sees its pinned v1 through WAL.
        app.store.transaction(() => {
          app.store.database.prepare('UPDATE entities SET data=? WHERE id=?').run(JSON.stringify(initial.revision), id);
          app.store.database.prepare('DELETE FROM versions WHERE id=?').run(committed!.version.id as string);
          app.store.database.prepare('DELETE FROM activity WHERE id=?').run(committed!.activity.id as string);
        });
      }
      const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(`
        import { parentPort, workerData } from 'node:worker_threads'; import { DatabaseSync } from 'node:sqlite';
        const db=new DatabaseSync(workerData.databasePath); db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
        db.prepare('UPDATE object_policies SET data=? WHERE object_id=?').run(JSON.stringify(workerData.policy),workerData.policy.objectId);
        db.prepare("UPDATE policy_meta SET value=value+1 WHERE name='epoch'").run();
        if(workerData.committed){const c=workerData.committed;db.prepare('UPDATE entities SET data=? WHERE id=?').run(c.entity.data,c.entity.id);db.prepare('INSERT INTO versions (id,revision_id,number,data) VALUES (?,?,?,?)').run(c.version.id,c.version.revision_id,c.version.number,c.version.data);db.prepare('INSERT INTO activity (sequence,id,object_id,data) VALUES (?,?,?,?)').run(c.activity.sequence,c.activity.id,c.activity.object_id,c.activity.data);}
        if(workerData.replay){const r=workerData.replay;db.prepare('INSERT INTO idempotency (key,fingerprint,status,body,created_at) VALUES (?,?,?,?,?)').run(r.key,r.fingerprint,r.status,r.body,r.created_at);}
        parentPort.once('message',()=>{db.exec('COMMIT');db.close();parentPort.close();});parentPort.postMessage('locked');
      `)}`), { workerData: { databasePath, policy, replay, committed } });
      try {
        assert.deepEqual(await once(worker, 'message'), ['locked']); let entered = 0;
        app.store.transaction = function<T>(work: () => T): T { entered++; app.store.transaction = transaction; worker.postMessage('commit'); return transaction(work); };
        const denied = await app.request(route(id), 'POST', body, 'alice', key); assert.equal(entered, 1); assert.equal(denied.status, reference === 'source' ? 404 : 403);
        assert.deepEqual(app.store.detail(id), before); assert.deepEqual(app.rows('versions'), versions); assert.deepEqual(app.rows('activity'), activity);
        if (replay) assert.equal(app.store.database.prepare('SELECT body FROM idempotency WHERE key=?').get(replay.key)!.body, replay.body);
      } finally { app.store.transaction = transaction; await worker.terminate(); }
    }
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('disconnect and shutdown cancel unfinished version imports without changing existing source or replay state', { timeout: 20_000 }, async () => {
  let gate = deferred<GitImportSnapshot>(); let entered = deferred<AbortSignal>();
  const app = await start({ gitObserver: observer(async (_id, _commit, signal) => { assert.ok(signal); entered.resolve(signal); return gate.promise; }) });
  try {
    const initial = app.create(); const body = input(initial); const path = route(initial.revision.id); const before = app.evidence();
    const controller = new AbortController(); const response = fetch(app.origin + path, { method: 'POST', signal: controller.signal, headers: { Authorization: `Bearer ${app.tokens.alice}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'disconnect' }, body: JSON.stringify(body) });
    const rejection = assert.rejects(response); const signal = await entered.promise; const aborted = once(signal, 'abort'); controller.abort(); await rejection; await aborted; gate.resolve(snapshot());
    gate = deferred<GitImportSnapshot>(); entered = deferred<AbortSignal>(); const pending = app.request(path, 'POST', body, 'alice', 'shutdown'); const shuttingDown = await entered.promise;
    await app.shutdown(); assert.equal(shuttingDown.aborted, true); assert.equal((await pending).body.code, 'GIT_ABORTED'); assert.deepEqual(app.evidence(), before);
  } finally { await app.close(); }
});
