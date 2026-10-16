import { withoutRepositoryOperationsSchema } from '../tests/migration-fixture.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, type AppOptions } from './app.ts';
import { Store } from './store.ts';
import { createAuth } from './auth.ts';
import type { RevisionDetail, Task } from '../shared/types.ts';
import type { HeraldRule, HeraldRuleInput, HeraldTranscript } from '../shared/herald.ts';
import type { BuildPlan, BuildDetail, BuildClaim } from '../shared/harbormaster.ts';

const ruleInput = (patch: Partial<HeraldRuleInput> = {}): HeraldRuleInput => ({ name: 'Automatic checks', contentType: 'revision', ruleType: 'global', objectId: null, enabled: true, match: 'all', repetition: 'every', conditions: [{ field: 'always', operator: 'true', value: null }], actions: [{ type: 'nothing' }], ...patch });
const planInput = (external = false) => ({ name: 'Checks', description: '', enabled: true, steps: [{ key: 'checks', name: 'Verify source', kind: external ? 'external' : 'local-checks', worker: external ? 'fixture' : null, dependsOn: [] }] });
async function fixture(options: AppOptions = {}) {
  const app = createApp({ databasePath: ':memory:', seed: false, ...options });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  async function request<T>(path: string, method = 'GET', body?: unknown, key = randomUUID(), token?: string) {
    const result = await fetch(origin + path, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Idempotency-Key': key }), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: result.status, body: await result.json() as T };
  }
  const create = () => request<RevisionDetail>('/api/revisions', 'POST', { kind: 'code', title: 'Exact automation', testPlan: 'Inspect build evidence.', files: [{ path: 'example.ts', content: 'export const answer = 42;\n' }] });
  return { ...app, request, create };
}

test('automatic Herald builds bind one event and immutable source, survive exact retry, and dry runs have no effects', async () => {
  const app = await fixture();
  try {
    const plan = (await app.request<{ plan: BuildPlan }>('/api/harbormaster/plans', 'POST', planInput())).body.plan;
    const rule = await app.request('/api/herald/rules', 'POST', ruleInput({ actions: [{ type: 'run-build-plans', targets: [plan.id] }] })); assert.equal(rule.status, 201);
    const revision = await app.create(); assert.equal(revision.status, 201, JSON.stringify(revision.body));
    const id = revision.body.revision.id, source = revision.body.versions[0]!;
    const builds = () => app.automation.harbormaster.list({ principalId: `local:${app.auth.workspaceId}`, workspaceId: app.auth.workspaceId, displayName: 'You' }, id);
    assert.equal(builds().length, 1); assert.equal(builds()[0]!.status, 'passed');
    const key = randomUUID(), input = { expectedVersion: 1, files: [{ path: 'example.ts', content: 'export const answer = 43;\n' }], message: 'Updated source' };
    const first = await app.request(`/api/revisions/${id}/versions`, 'POST', input, key); assert.equal(first.status, 201);
    const retry = await app.request(`/api/revisions/${id}/versions`, 'POST', input, key); assert.equal(retry.status, first.status); assert.deepEqual(retry.body, first.body); assert.equal(builds().length, 2);
    const detail = (await app.request<BuildDetail>(`/api/harbormaster/builds/${builds().at(-1)!.id}`)).body; assert.equal(detail.buildable.versionId, source.id); assert.equal(detail.buildable.contentHash, source.contentHash);
    const dry = await app.request<{ transcript: HeraldTranscript }>('/api/herald/test', 'POST', { objectId: id }); assert.equal(dry.status, 200); assert.equal(dry.body.transcript.dryRun, true); assert.equal(dry.body.transcript.actions[0]!.status, 'dry-run'); assert.equal(builds().length, 2);
    const transcripts = (await app.request<{ transcripts: HeraldTranscript[] }>('/api/herald/transcripts')).body.transcripts; assert.equal(transcripts.filter(item => !item.dryRun).length, 2);
    assert.equal(app.store.detail(id).reviews.length, 0, 'builds are explicit separate evidence, not invented reviewer acceptance');
  } finally { await app.close(); }
});

test('task actions run once without recursive rules; all rules inspect the original snapshot', async () => {
  const app = await fixture();
  try {
    await app.request('/api/herald/rules', 'POST', ruleInput({ name: 'Resolve', contentType: 'task', actions: [{ type: 'task-status', value: 'resolved' }, { type: 'comment', value: 'Recorded once.' }] }));
    await app.request('/api/herald/rules', 'POST', ruleInput({ name: 'Would loop if recursive', contentType: 'task', conditions: [{ field: 'status', operator: 'is', value: 'resolved' }], actions: [{ type: 'comment', value: 'Should never run on initial open snapshot.' }] }));
    const response = await app.request<Task>('/api/tasks', 'POST', { title: 'Route task' }); assert.equal(response.status, 201, JSON.stringify(response.body));
    const detail = app.store.taskDetail(response.body.id); assert.equal(detail.task.status, 'resolved'); assert.equal(detail.history.transactions.filter(item => item.kind === 'comment').length, 1);
    const transcripts = (await app.request<{ transcripts: HeraldTranscript[] }>('/api/herald/transcripts')).body.transcripts; assert.equal(transcripts.length, 1); assert.equal(transcripts[0]!.snapshot.status, 'open'); assert.equal(transcripts[0]!.rules[1]!.status, 'not-matched');
  } finally { await app.close(); }
});

test('external workers use exact target leases and append results against the original source', async () => {
  const app = await fixture();
  try {
    const revision = (await app.create()).body, source = revision.versions[0]!, plan = (await app.request<{ plan: BuildPlan }>('/api/harbormaster/plans', 'POST', planInput(true))).body.plan;
    const started = await app.request<BuildDetail>('/api/harbormaster/builds', 'POST', { revisionId: revision.revision.id, versionId: source.id, contentHash: source.contentHash, planId: plan.id, planVersion: plan.version }); assert.equal(started.status, 201);
    const target = started.body.targets[0]!, claim = await app.request<BuildClaim>(`/api/harbormaster/targets/${target.id}/claim`, 'POST', { expectedVersion: target.version, worker: 'fixture' }); assert.equal(claim.status, 200); assert.deepEqual(claim.body.source?.files, source.files);
    await app.request(`/api/revisions/${revision.revision.id}/versions`, 'POST', { expectedVersion: 1, files: [{ path: 'next.ts', content: 'new head' }], message: 'Later source' });
    const report = { leaseToken: claim.body.leaseToken, reportId: 'result-1', type: 'pass', log: 'Exact source passed.', unit: [{ name: 'Fixture', result: 'pass' }], artifacts: [{ key: 'report', name: 'Report', uri: 'https://example.invalid/report' }] };
    const result = await app.request<BuildDetail>(`/api/harbormaster/targets/${target.id}/report`, 'POST', report); assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.build.status, 'passed'); assert.equal(result.body.buildable.versionId, source.id);
    const replay = await app.request<BuildDetail>(`/api/harbormaster/targets/${target.id}/report`, 'POST', report); assert.equal(replay.status, 200); assert.equal(replay.body.reports.length, 1);
    const forged = await app.request(`/api/harbormaster/targets/${target.id}/report`, 'POST', { ...report, leaseToken: 'wrong', reportId: 'result-2' }); assert.ok([403, 409].includes(forged.status));
  } finally { await app.close(); }
});

test('global rules, worker reporting and private build/transcript reads respect current authenticated authority', async () => {
  const store = new Store({ path: ':memory:' }); const auth = createAuth({ database: store.database, mode: 'local', basePath: '/', provisioning: true });
  const alice = await auth.createAccount({ username: 'alice', displayName: 'Alice', password: 'Alice automation test password' }), bob = await auth.createAccount({ username: 'bob', displayName: 'Bob', password: 'Bob automation test password' });
  const app = await fixture({ store, authMode: 'password', automation: { managers: ['alice'], workers: ['alice'] } });
  const a = app.auth.createToken(alice.id, { name: 'test', scopes: ['read', 'write'] }).token, b = app.auth.createToken(bob.id, { name: 'test', scopes: ['read', 'write'] }).token;
  try {
    assert.equal((await app.request('/api/herald/rules', 'POST', ruleInput(), randomUUID(), b)).status, 403);
    assert.equal((await app.request('/api/herald/rules', 'POST', ruleInput(), randomUUID(), a)).status, 201);
    const revision = await app.request<RevisionDetail>('/api/revisions', 'POST', { kind: 'code', title: 'Private', testPlan: 'Read permissions', files: [{ path: 'a.ts', content: 'private' }] }, randomUUID(), a); assert.equal(revision.status, 201);
    const source = revision.body.versions[0]!, id = revision.body.revision.id;
    const plan = (await app.request<{ plan: BuildPlan }>('/api/harbormaster/plans', 'POST', planInput(true), randomUUID(), a)).body.plan;
    const build = (await app.request<BuildDetail>('/api/harbormaster/builds', 'POST', { revisionId: id, versionId: source.id, contentHash: source.contentHash, planId: plan.id, planVersion: 1 }, randomUUID(), a)).body;
    assert.equal((await app.request(`/api/harbormaster/targets/${build.targets[0]!.id}/claim`, 'POST', { expectedVersion: 1, worker: 'fixture' }, randomUUID(), b)).status, 403);
    const policy = app.policies.policy(id, alice.id), onlyAlice = { kind: 'principals' as const, principalIds: [alice.id] }; app.policies.setPolicy(id, { expectedVersion: policy.version, spaceId: policy.spaceId, view: onlyAlice, edit: onlyAlice, interact: onlyAlice }, alice.id);
    assert.ok([403, 404].includes((await app.request(`/api/harbormaster/builds/${build.build.id}`, 'GET', undefined, randomUUID(), b)).status));
    assert.deepEqual((await app.request<{ transcripts: HeraldTranscript[] }>('/api/herald/transcripts', 'GET', undefined, randomUUID(), b)).body.transcripts, []);
    assert.deepEqual((await app.request<{ builds: unknown[] }>('/api/harbormaster/builds', 'GET', undefined, randomUUID(), b)).body.builds, []);
    const key = randomUUID(); assert.equal((await app.request('/api/herald/test', 'POST', { objectId: id }, key, a)).status, 200);
    app.store.database.prepare('UPDATE auth_accounts SET disabled=1 WHERE id=?').run(alice.id);
    assert.equal((await app.request('/api/herald/test', 'POST', { objectId: id }, key, a)).status, 401);
  } finally { await app.close(); store.close(); }
});

function snapshot(db: DatabaseSync) { return db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => ({ name: String(row.name), sql: row.sql, rows: db.prepare(`SELECT * FROM "${String(row.name).replaceAll('"', '""')}" ORDER BY rowid`).all() })); }
test('schema37 adds automation without rewriting any existing schema36 rows and rejects future versions', () => {
  const directory = mkdtempSync(join(tmpdir(), 'automation-migration-')), path = join(directory, 'db.sqlite'); let store = new Store({ path });
  try {
    store.createTask({ title: 'Preserve existing work' });
    const tables = store.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'herald_%' OR name LIKE 'harbormaster_%')").all().map(row => String(row.name));
    store.database.exec('PRAGMA foreign_keys=OFF'); for (const table of tables.reverse()) store.database.exec(`DROP TABLE ${table}`); withoutRepositoryOperationsSchema(store.database).exec('PRAGMA user_version=36'); const before = snapshot(store.database); store.close();
    store = new Store({ path }); assert.equal(store.database.prepare('PRAGMA user_version').get()!.user_version, 46); const after = snapshot(store.database); for (const table of before) assert.deepEqual(after.find(item => item.name === table.name), table); assert.deepEqual(store.database.prepare('PRAGMA foreign_key_check').all(), []);
    store.database.exec('PRAGMA user_version=47'); store.close(); assert.throws(() => new Store({ path }), /newer than/);
  } finally { try { store.close(); } catch { /* Already closed for reopen. */ } rmSync(directory, { recursive: true, force: true }); }
});

test('Herald comment conditions see new reply and batch bodies without older discussion content', async () => {
  const app = await fixture();
  try {
    const revision = (await app.create()).body, id = revision.revision.id, versionId = revision.versions[0]!.id;
    const root = (await app.request<{ id: string; threadId: string }>(`/api/revisions/${id}/comments`, 'POST', { versionId, body: 'Older root comment' })).body;
    await app.request('/api/herald/rules', 'POST', ruleInput({ conditions: [{ field: 'comment', operator: 'contains', value: 'New reply token' }] }));
    const response = await app.request(`/api/revisions/${id}/threads/${root.threadId}/replies`, 'POST', { viewedVersionId: versionId, body: 'New reply token' }); assert.equal(response.status, 201, JSON.stringify(response.body));
    let transcripts = (await app.request<{ transcripts: HeraldTranscript[] }>('/api/herald/transcripts')).body.transcripts;
    assert.equal(transcripts[0]!.snapshot.comment, 'New reply token'); assert.equal(transcripts[0]!.rules[0]!.matched, true);
    const actor = { principalId: `local:${app.auth.workspaceId}`, displayName: 'You', credentialId: null, requestId: randomUUID() };
    app.store.mutate(undefined, randomUUID(), () => { app.store.createComment(id, { versionId, body: 'First batch body' }, actor); app.store.createComment(id, { versionId, body: 'Second batch body' }, actor); return { status: 200, body: {} }; });
    transcripts = (await app.request<{ transcripts: HeraldTranscript[] }>('/api/herald/transcripts')).body.transcripts;
    assert.equal(transcripts[0]!.snapshot.comment, 'First batch body\nSecond batch body');
  } finally { await app.close(); }
});
