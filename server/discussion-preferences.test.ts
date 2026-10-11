import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import type { AddressInfo } from 'node:net';
import { Store, contentHash } from './store.ts';
import { createApp } from './app.ts';
import { createAuth } from './auth.ts';
import { initializePolicies, upgradeProjectPolicies } from './policy.ts';
import { initializeProjects } from './projects.ts';
import { initializeProjectHierarchy } from './project-graph.ts';
import { initializeWorkboards } from './workboards.ts';
import type { DiscussionPreferences, ThreadPreference } from '../shared/discussion.ts';
import type { RevisionDetail } from '../shared/types.ts';

const selected = (...principalIds: string[]) => ({ kind: 'principals' as const, principalIds });
const workspace = { kind: 'workspace' as const };
const status = (expected: number) => (error: unknown) => error !== null && typeof error === 'object' && 'status' in error && error.status === expected;
const route = (id: string, threadId?: string) => `/api/revisions/${id}/${threadId ? `threads/${threadId}/preference` : 'discussion-preferences'}`;
const raw = (db: DatabaseSync, table: string) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
const evidence = (db: DatabaseSync) => new Map((db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> 'thread_preferences' AND name <> 'idempotency' AND name NOT IN ('paper_builds','paper_build_artifacts') ORDER BY name").all() as { name: string }[]).map(({ name }) => [name, raw(db, name)]));
function fixture(store: Store, repositoryId: string | null = null) {
  const detail = store.createRevision({ kind: 'document', title: 'Collapse a discussion', repositoryId, files: [{ path: 'motion.md', content: 'Original claim.\n' }] });
  const id = detail.revision.id; const version = detail.versions[0]!;
  const comment = store.createComment(id, { versionId: version.id, filePath: 'motion.md', passage: { start: 0, end: 8, quote: 'Original' }, body: 'Shared explanation', suggestion: { replacement: 'Revised' } });
  store.createReply(id, comment.id, { viewedVersionId: version.id, body: 'Shared reply' });
  store.updateThread(id, comment.id, { status: 'resolved', expectedThreadVersion: 2, versionId: version.id });
  store.saveReview(id, 1, { provider: 'local', model: 'deterministic-checks', summary: 'Existing evidence', findings: [] });
  store.updateRevision(id, { status: 'accepted', expectedVersion: 1 });
  return { id, threadId: comment.id, detail: store.detail(id) };
}

test('personal collapse has independent CAS, no-op defaults and no effects on shared evidence or acceptance', () => {
  const store = new Store({ path: ':memory:' });
  try {
    const { id, threadId, detail } = fixture(store); const before = evidence(store.database);
    const expanded = { revisionId: id, threadId, collapsed: false, version: 0, updatedAt: null };
    assert.deepEqual(store.discussionPreferences(id, 'alice'), { revisionId: id, preferences: [expanded] });
    assert.deepEqual(store.setThreadPreference(id, threadId, { collapsed: false, expectedVersion: 0 }, 'alice'), expanded);
    assert.deepEqual(raw(store.database, 'thread_preferences'), []);
    const saved = store.setThreadPreference(id, threadId, { collapsed: true, expectedVersion: 0 }, 'alice');
    assert.equal(saved.version, 1); assert.ok(saved.updatedAt); assert.equal(saved.collapsed, true);
    assert.deepEqual(store.setThreadPreference(id, threadId, { collapsed: true, expectedVersion: 1 }, 'alice'), saved);
    assert.throws(() => store.setThreadPreference(id, threadId, { collapsed: true, expectedVersion: 0 }, 'alice'), status(409));
    assert.deepEqual(store.threadPreference(id, threadId, 'bob'), expanded);
    assert.equal(store.setThreadPreference(id, threadId, { collapsed: true, expectedVersion: 0 }, 'bob').version, 1);
    const reopened = store.setThreadPreference(id, threadId, { collapsed: false, expectedVersion: 1 }, 'alice');
    assert.equal(reopened.version, 2); assert.equal(reopened.collapsed, false);
    assert.equal(store.threadPreference(id, threadId, 'bob').collapsed, true);
    assert.deepEqual(evidence(store.database), before); assert.deepEqual(store.detail(id), detail);
    assert.equal(store.detail(id).revision.status, 'accepted');
    store.createReply(id, threadId, { viewedVersionId: detail.versions[0]!.id, body: 'Later shared reply' });
    store.createVersion(id, { expectedVersion: 1, files: [{ path: 'motion.md', content: 'New head' }], message: 'New version' });
    assert.deepEqual(store.threadPreference(id, threadId, 'alice'), reopened, 'new content and replies do not alter a viewer preference');
  } finally { store.close(); }
});

test('invalid identities, shapes, integer bounds and failed writes leave personal and shared data unchanged', () => {
  const store = new Store({ path: ':memory:' });
  try {
    const { id, threadId } = fixture(store); const foreign = fixture(store); const before = evidence(store.database);
    for (const input of [null, [], {}, { collapsed: true }, { collapsed: 1, expectedVersion: 0 }, { collapsed: false, expectedVersion: -1 }, { collapsed: true, expectedVersion: 0.5 }, { collapsed: true, expectedVersion: Number.MAX_SAFE_INTEGER + 1 }, { collapsed: true, expectedVersion: 0, principalId: 'bob' }, { collapsed: true, expectedVersion: 0, revisionId: id }, { collapsed: true, expectedVersion: 0, threadId }]) assert.throws(() => store.setThreadPreference(id, threadId, input, 'alice'), status(400));
    for (const badId of ['missing', 'x'.repeat(101), foreign.threadId]) assert.throws(() => store.setThreadPreference(id, badId, { collapsed: true, expectedVersion: 0 }, 'alice'), error => status(404)(error) && (error as { code: string }).code === 'THREAD_UNAVAILABLE');
    assert.throws(() => store.setThreadPreference(id, threadId, { collapsed: true, expectedVersion: 0 }, ''), status(400));
    assert.deepEqual(raw(store.database, 'thread_preferences'), []); assert.deepEqual(evidence(store.database), before);
    store.database.exec("CREATE TRIGGER fail_preference BEFORE INSERT ON thread_preferences BEGIN SELECT RAISE(ABORT, 'injected preference failure'); END");
    assert.throws(() => store.mutate('failed-personal-write', 'same', () => ({ status: 200, body: store.setThreadPreference(id, threadId, { collapsed: true, expectedVersion: 0 }, 'alice') })), /injected preference failure/);
    assert.deepEqual(raw(store.database, 'thread_preferences'), []); assert.deepEqual(raw(store.database, 'idempotency'), []); assert.deepEqual(evidence(store.database), before);
    store.database.exec('DROP TRIGGER fail_preference');
    store.setThreadPreference(id, threadId, { collapsed: true, expectedVersion: 0 }, 'alice');
    store.database.prepare('UPDATE thread_preferences SET version=? WHERE thread_id=?').run(Number.MAX_SAFE_INTEGER, threadId);
    const capped = store.threadPreference(id, threadId, 'alice');
    assert.throws(() => store.setThreadPreference(id, threadId, { collapsed: false, expectedVersion: Number.MAX_SAFE_INTEGER }, 'alice'), status(409));
    assert.deepEqual(store.setThreadPreference(id, threadId, { collapsed: true, expectedVersion: Number.MAX_SAFE_INTEGER }, 'alice'), capped);
  } finally { store.close(); }
});

/** Construct the actual prior format directly; no current Store is relabeled. */
function schemaThirteen(path: string) {
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      CREATE TABLE entities(id TEXT PRIMARY KEY,kind TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE sequences(name TEXT PRIMARY KEY,value INTEGER NOT NULL);
      CREATE TABLE activity(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,object_id TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE idempotency(key TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,status INTEGER NOT NULL,body TEXT NOT NULL CHECK(json_valid(body)),created_at TEXT NOT NULL);
      CREATE TABLE versions(id TEXT PRIMARY KEY,revision_id TEXT NOT NULL REFERENCES entities(id),number INTEGER NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),UNIQUE(revision_id,number));
      CREATE TABLE comments(id TEXT PRIMARY KEY,revision_id TEXT NOT NULL REFERENCES entities(id),version_id TEXT NOT NULL REFERENCES versions(id),data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE reviews(id TEXT PRIMARY KEY,revision_id TEXT NOT NULL REFERENCES entities(id),version_id TEXT NOT NULL REFERENCES versions(id),data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE wiki_versions(id TEXT PRIMARY KEY,document_id TEXT NOT NULL REFERENCES entities(id),number INTEGER NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),UNIQUE(document_id,number));
      CREATE TABLE review_threads(id TEXT PRIMARY KEY,revision_id TEXT NOT NULL REFERENCES entities(id),root_comment_id TEXT NOT NULL UNIQUE REFERENCES comments(id),data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE thread_events(id TEXT PRIMARY KEY,revision_id TEXT NOT NULL REFERENCES entities(id),thread_id TEXT NOT NULL REFERENCES review_threads(id),version_id TEXT NOT NULL REFERENCES versions(id),data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE suggestion_applications(id TEXT PRIMARY KEY,revision_id TEXT NOT NULL REFERENCES entities(id),comment_id TEXT NOT NULL UNIQUE REFERENCES comments(id),thread_id TEXT NOT NULL REFERENCES review_threads(id),from_version_id TEXT NOT NULL REFERENCES versions(id),to_version_id TEXT NOT NULL REFERENCES versions(id),data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE task_transactions(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES entities(id),sequence INTEGER NOT NULL,task_version INTEGER NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),UNIQUE(task_id,sequence));
      CREATE TABLE task_dependencies(task_id TEXT NOT NULL REFERENCES entities(id),dependency_id TEXT NOT NULL REFERENCES entities(id),PRIMARY KEY(task_id,dependency_id));
      CREATE TABLE task_subscriptions(task_id TEXT NOT NULL REFERENCES entities(id),principal_id TEXT NOT NULL,state TEXT NOT NULL,version INTEGER NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(task_id,principal_id));
      CREATE TABLE task_duplicates(source_id TEXT NOT NULL REFERENCES entities(id),target_id TEXT NOT NULL REFERENCES entities(id),operation_id TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(source_id,target_id));
      CREATE TABLE task_projects(task_id TEXT NOT NULL REFERENCES entities(id),project_id TEXT NOT NULL REFERENCES entities(id),PRIMARY KEY(task_id,project_id));
      CREATE INDEX task_projects_project ON task_projects(project_id,task_id);
    `);
    for (const table of ['wiki_versions', 'comments', 'thread_events', 'suggestion_applications', 'task_transactions', 'task_duplicates']) for (const operation of ['update', 'delete']) db.exec(`CREATE TRIGGER ${table}_no_${operation} BEFORE ${operation.toUpperCase()} ON ${table} BEGIN SELECT RAISE(ABORT,'Immutable evidence'); END`);
    const now = '2024-01-01T00:00:00.000Z'; const source = [{ path: 'old.txt', content: 'Known old content' }];
    const revision = { id: 'D1', kind: 'code', title: 'Preserved revision', summary: '', status: 'accepted', projectId: null, repositoryId: null, author: 'Historical author', currentVersion: 1, createdAt: now, updatedAt: now };
    const version = { id: 'version-one', revisionId: 'D1', number: 1, files: source, contentHash: contentHash(source), message: 'Preserved message', author: 'Historical author', createdAt: now };
    const comment = { id: 'legacy-comment', threadId: 'legacy-comment', revisionId: 'D1', versionId: version.id, filePath: null, line: null, body: 'Preserved comment', author: 'Historical reviewer', createdAt: now };
    const thread = { id: comment.id, rootCommentId: comment.id, revisionId: 'D1', status: 'open', version: 1, createdAt: now, updatedAt: now };
    db.prepare("INSERT INTO entities VALUES(?,'revision',?)").run('D1', JSON.stringify(revision, null, 2));
    db.prepare('INSERT INTO versions VALUES(?,?,?,?)').run(version.id, 'D1', 1, JSON.stringify(version, null, 2));
    db.prepare('INSERT INTO comments VALUES(?,?,?,?)').run(comment.id, 'D1', version.id, JSON.stringify(comment, null, 2));
    db.prepare('INSERT INTO review_threads VALUES(?,?,?,?)').run(thread.id, 'D1', comment.id, JSON.stringify(thread, null, 2));
    db.prepare('INSERT INTO idempotency VALUES(?,?,?,?,?)').run('historical-response', 'historical-fingerprint', 201, JSON.stringify(comment, null, 2), now);
    db.prepare('INSERT INTO sequences VALUES(?,?)').run('revision', 1);
    initializePolicies(db); initializeProjects(db); upgradeProjectPolicies(db); initializeProjectHierarchy(db); initializeWorkboards(db);
    db.exec('PRAGMA user_version = 13');
    return { before: evidence(db), replay: raw(db, 'idempotency'), schemas: db.prepare("SELECT name, sql FROM sqlite_master WHERE type IN ('table','index','trigger') ORDER BY name").all() };
  } finally { db.close(); }
}

test('schema14 adds only empty private storage, preserves actual schema13 evidence and replay bytes, and survives restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'discussion-migration-')); const path = join(directory, 'workspace.sqlite');
  const old = schemaThirteen(path); let store = new Store({ path });
  try {
    assert.equal(store.database.prepare('PRAGMA user_version').get()!.user_version, 24); assert.equal(store.fresh, false);
    const historicalEvidence = () => new Map([...evidence(store.database)].filter(([name]) => old.before.has(name)));
    assert.deepEqual(historicalEvidence(), old.before); assert.deepEqual(raw(store.database, 'idempotency'), old.replay); assert.deepEqual(raw(store.database, 'thread_preferences'), []);
    // Schema16 widens the entity kind constraint; all child tables and prior
    // indexes/triggers retain their original definitions and evidence.
    for (const schema of old.schemas) if (schema.name !== 'entities') assert.deepEqual(store.database.prepare('SELECT name, sql FROM sqlite_master WHERE name=?').get(schema.name as string), schema);
    assert.match(String(store.database.prepare("SELECT sql FROM sqlite_master WHERE name='entities'").get()!.sql), /'file'/);
    const original = store.detail('D1'); const preference = store.setThreadPreference('D1', 'legacy-comment', { collapsed: true, expectedVersion: 0 }, 'local:legacy-workspace');
    store.close(); store = new Store({ path });
    assert.deepEqual(store.threadPreference('D1', 'legacy-comment', 'local:legacy-workspace'), preference);
    assert.deepEqual(store.detail('D1'), original); assert.deepEqual(historicalEvidence(), old.before); assert.deepEqual(raw(store.database, 'idempotency'), old.replay);
    assert.equal(store.threadPreference('D1', 'legacy-comment', 'another-principal').collapsed, false);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('failed schema14 migration rolls its new table back and leaves schema13 available for a later upgrade', () => {
  const directory = mkdtempSync(join(tmpdir(), 'discussion-migration-fail-')); const path = join(directory, 'workspace.sqlite'); const old = schemaThirteen(path);
  const exec = DatabaseSync.prototype.exec;
  try {
    DatabaseSync.prototype.exec = function(sql: string) { if (sql === 'PRAGMA user_version = 14') throw new Error('injected migration failure after table creation'); return exec.call(this, sql); };
    assert.throws(() => new Store({ path }), /injected migration failure/);
  } finally { DatabaseSync.prototype.exec = exec; }
  try {
    const db = new DatabaseSync(path);
    try { assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 13); assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='thread_preferences'").get(), undefined); assert.deepEqual(evidence(db), old.before); assert.deepEqual(raw(db, 'idempotency'), old.replay); } finally { db.close(); }
    const store = new Store({ path }); try { assert.equal(store.database.prepare('PRAGMA user_version').get()!.user_version, 24); } finally { store.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

async function start(databasePath = ':memory:') {
  const store = new Store({ path: databasePath }); const provisioning = createAuth({ database: store.database, mode: 'local', basePath: '/', provisioning: true });
  const alice = await provisioning.createAccount({ username: 'alice', displayName: 'Alice', password: 'Alice discussion preference password' });
  const bob = await provisioning.createAccount({ username: 'bob', displayName: 'Bob', password: 'Bob discussion preference password' });
  const app = createApp({ store, seed: false, authMode: 'password' });
  const tokens = { alice: app.auth.createToken(alice.id, { name: 'Alice', scopes: ['read', 'write'] }), bob: app.auth.createToken(bob.id, { name: 'Bob', scopes: ['read', 'write'] }), reader: app.auth.createToken(alice.id, { name: 'Read only', scopes: ['read'] }) };
  store.createRepository({ name: 'Linked repository', remoteUrl: 'https://example.invalid/source.git' });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  async function request<T = { error: string; code?: string }>(path: string, method = 'GET', body?: unknown, actor: keyof typeof tokens = 'alice', key?: string) {
    const response = await fetch(origin + path, { method, signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${tokens[actor].token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as T };
  }
  function policy(id: string, changes: Record<string, unknown>) { const p = app.policies.policy(id, bob.id); return app.policies.setPolicy(id, { expectedVersion: p.version, spaceId: p.spaceId, ...p.rules, ...changes }, bob.id); }
  return { ...app, alice, bob, tokens, origin, request, policy, close: async () => { await app.close(); store.close(); } };
}

test('HTTP preferences are private, permit view-only members with write tokens, and preserve historical replay values', async () => {
  const app = await start();
  try {
    const { id, threadId } = fixture(app.store, 'R1'); app.policy(id, { edit: selected(app.bob.id), interact: selected(app.bob.id) });
    assert.equal(app.policies.access(id, app.alice.id).interact, false); assert.equal(app.policies.access(id, app.alice.id).edit, false);
    const before = evidence(app.store.database); const detail = (await app.request<RevisionDetail>(`/api/revisions/${id}`)).body;
    const defaults = await app.request<DiscussionPreferences>(route(id)); assert.equal(defaults.status, 200); assert.equal(defaults.body.preferences[0]!.version, 0); assert.equal(defaults.body.accessEpoch, app.policies.epoch());
    assert.equal((await app.request(route(id, threadId), 'PATCH', { collapsed: true, expectedVersion: 0 }, 'reader')).status, 403);
    assert.equal((await app.request(route(id), 'GET', undefined, 'reader')).status, 200);
    const first = await app.request<ThreadPreference>(route(id, threadId), 'PATCH', { collapsed: true, expectedVersion: 0 }, 'alice', 'same-key'); assert.equal(first.status, 200); assert.equal(first.body.version, 1);
    assert.equal((await app.request<DiscussionPreferences>(route(id), 'GET', undefined, 'bob')).body.preferences[0]!.version, 0);
    const bob = await app.request<ThreadPreference>(route(id, threadId), 'PATCH', { collapsed: false, expectedVersion: 0 }, 'bob', 'same-key'); assert.equal(bob.status, 200); assert.equal(bob.body.version, 0, 'principal-scoped same key cannot replay Alice');
    const second = await app.request<ThreadPreference>(route(id, threadId), 'PATCH', { collapsed: false, expectedVersion: 1 }); assert.equal(second.body.version, 2);
    assert.deepEqual(await app.request(route(id, threadId), 'PATCH', { collapsed: true, expectedVersion: 0 }, 'alice', 'same-key'), first);
    assert.equal((await app.request<DiscussionPreferences>(route(id))).body.preferences[0]!.version, 2);
    assert.equal((await app.request(route(id, threadId), 'PATCH', { collapsed: false, expectedVersion: 0 }, 'alice', 'same-key')).status, 409);
    assert.equal((await app.request(route(id, threadId), 'PATCH', { collapsed: false, expectedVersion: 1 })).status, 409);
    assert.deepEqual((await app.request(`/api/revisions/${id}`)).body, detail); assert.deepEqual(evidence(app.store.database), before);
    assert.ok(!JSON.stringify(first.body).includes(app.alice.id)); assert.ok(!JSON.stringify(detail).includes('collapsed'));
    for (const input of [{ collapsed: true, expectedVersion: 2, principalId: app.bob.id }, { collapsed: true, expectedVersion: 2, revisionId: id }, { collapsed: true, expectedVersion: 2, threadId }, { collapsed: true, expectedVersion: -1 }, { collapsed: 'true', expectedVersion: 2 }]) assert.equal((await app.request(route(id, threadId), 'PATCH', input)).status, 400);
    assert.equal((await app.request(`${route(id)}?principalId=${app.bob.id}`)).status, 400);
    const foreign = fixture(app.store); const missing = await app.request(route(foreign.id, threadId), 'PATCH', { collapsed: true, expectedVersion: 0 }); assert.equal(missing.status, 404); assert.equal(missing.body.code, 'THREAD_UNAVAILABLE');
    const concurrent = await Promise.all(['one', 'two'].map(key => app.request(route(id, threadId), 'PATCH', { collapsed: true, expectedVersion: 2 }, 'alice', key))); assert.deepEqual(concurrent.map(r => r.status).sort(), [200, 409]);
  } finally { await app.close(); }
});

test('current revision, continuing repository, Space and credential authority protect fresh reads and saved preference retries', async () => {
  const app = await start();
  try {
    const { id, threadId } = fixture(app.store, 'R1'); const input = { collapsed: true, expectedVersion: 0 };
    assert.equal((await app.request(route(id, threadId), 'PATCH', input, 'alice', 'saved')).status, 200); const rows = raw(app.store.database, 'thread_preferences'); const receipt = raw(app.store.database, 'idempotency');
    for (const reference of [id, 'R1']) {
      app.policy(reference, { view: selected(app.bob.id), edit: selected(app.bob.id) });
      for (const read of [true, false]) { const denied = read ? await app.request(route(id)) : await app.request(route(id, threadId), 'PATCH', input, 'alice', 'saved'); assert.equal(denied.status, 404); assert.equal(denied.body.code, 'OBJECT_UNAVAILABLE'); }
      app.policy(reference, { view: workspace, edit: workspace });
    }
    const space = app.policies.createSpace({ name: 'Source Space', view: workspace, edit: selected(app.bob.id) }, app.bob.id); app.policy('R1', { spaceId: space.id });
    app.policies.updateSpace(space.id, { expectedVersion: space.version, view: selected(app.bob.id) }, app.bob.id);
    assert.equal((await app.request(route(id))).status, 404); assert.equal((await app.request(route(id, threadId), 'PATCH', input, 'alice', 'saved')).status, 404);
    app.policies.updateSpace(space.id, { expectedVersion: space.version + 1, view: workspace }, app.bob.id);
    assert.equal((await app.request(route(id, threadId), 'PATCH', input, 'alice', 'saved')).status, 200);
    app.auth.revokeToken(app.alice.id, app.tokens.alice.record.id);
    assert.equal((await app.request(route(id))).status, 401); assert.equal((await app.request(route(id, threadId), 'PATCH', input, 'alice', 'saved')).status, 401);
    assert.deepEqual(raw(app.store.database, 'thread_preferences'), rows); assert.deepEqual(raw(app.store.database, 'idempotency'), receipt);
  } finally { await app.close(); }
});

test('writer-lock authority checks and CAS reject concurrent preference changes or newly saved inaccessible receipts', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'discussion-lock-')); const databasePath = join(directory, 'workspace.sqlite'); const app = await start(databasePath); const transaction = app.store.transaction.bind(app.store);
  try {
    for (const scenario of ['cas', 'target', 'source', 'credential', 'replay'] as const) {
      app.policy('R1', { view: workspace, edit: workspace }); app.store.database.prepare('UPDATE auth_tokens SET revoked=0 WHERE id=?').run(app.tokens.alice.record.id);
      const { id, threadId } = fixture(app.store, 'R1'); const input = { collapsed: true, expectedVersion: 0 }; const key = `lock-${scenario}`;
      let replay: Record<string, unknown> | undefined;
      if (scenario === 'replay') {
        assert.equal((await app.request(route(id, threadId), 'PATCH', input, 'alice', key)).status, 200);
        replay = app.store.database.prepare('SELECT * FROM idempotency ORDER BY rowid DESC LIMIT 1').get(); assert.ok(replay);
        app.store.database.prepare('DELETE FROM idempotency WHERE key=?').run(replay.key as string); app.store.database.prepare('DELETE FROM thread_preferences WHERE thread_id=?').run(threadId);
      }
      const policy = app.policies.policy(scenario === 'target' ? id : 'R1', app.bob.id);
      const restricted = { ...policy, version: policy.version + 1, rules: { ...policy.rules, view: selected(app.bob.id), edit: selected(app.bob.id) } };
      const shared = app.store.detail(id); const now = new Date().toISOString();
      const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(`
        import { parentPort,workerData as w } from 'node:worker_threads';import { DatabaseSync } from 'node:sqlite';
        const db=new DatabaseSync(w.databasePath);db.exec('PRAGMA busy_timeout=5000;BEGIN IMMEDIATE');
        if(w.scenario==='cas'||w.scenario==='replay')db.prepare('INSERT INTO thread_preferences VALUES(?,?,?,?,?)').run(w.threadId,w.principalId,1,1,w.now);
        if(w.scenario==='target'||w.scenario==='source'||w.scenario==='replay'){db.prepare('UPDATE object_policies SET data=? WHERE object_id=?').run(JSON.stringify(w.restricted),w.restricted.objectId);db.prepare("UPDATE policy_meta SET value=value+1 WHERE name='epoch'").run();}
        if(w.scenario==='credential')db.prepare('UPDATE auth_tokens SET revoked=1 WHERE id=?').run(w.tokenId);
        if(w.replay){const r=w.replay;db.prepare('INSERT INTO idempotency VALUES(?,?,?,?,?)').run(r.key,r.fingerprint,r.status,r.body,r.created_at);}
        parentPort.once('message',()=>{db.exec('COMMIT');db.close();parentPort.close();});parentPort.postMessage('locked');
      `)}`), { workerData: { databasePath, threadId, principalId: app.alice.id, scenario, restricted, tokenId: app.tokens.alice.record.id, replay, now } });
      try {
        assert.deepEqual(await once(worker, 'message'), ['locked']); let entered = 0;
        app.store.transaction = function<T>(work: () => T): T { entered++; app.store.transaction = transaction; worker.postMessage('commit'); return transaction(work); };
        const denied = await app.request(route(id, threadId), 'PATCH', input, 'alice', key); assert.equal(entered, 1); assert.equal(denied.status, scenario === 'cas' ? 409 : scenario === 'credential' ? 401 : 404);
        assert.deepEqual(app.store.detail(id), shared); const current = app.store.threadPreference(id, threadId, app.alice.id);
        assert.equal(current.version, scenario === 'cas' || scenario === 'replay' ? 1 : 0);
        if (replay) assert.equal(app.store.database.prepare('SELECT body FROM idempotency WHERE key=?').get(replay.key as string)!.body, replay.body);
        else assert.equal(app.store.database.prepare('SELECT 1 FROM idempotency WHERE key LIKE ?').get(`%:${key}`), undefined);
      } finally { app.store.transaction = transaction; await worker.terminate(); }
    }
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});
