import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from './app.ts';
import { createAuth } from './auth.ts';
import { Store } from './store.ts';
import type { BuildClaim, BuildDetail, BuildPlan } from '../shared/harbormaster.ts';
import type { RevisionDetail } from '../shared/types.ts';
import type { ConduitEnvelope } from './conduit.ts';

const localStep = { key: 'check', name: 'Checks', kind: 'local-checks', dependsOn: [], worker: null };
const externalStep = { key: 'test', name: 'Worker tests', kind: 'external', dependsOn: [], worker: 'linux' };
interface Search { data: { id: string; phid: string; fields: Record<string, unknown> }[]; cursor: { after: string | null; before: string | null }; compatibility: { identities: string; status: string } }
async function start(basePath = '/') {
  const store = new Store({ path: ':memory:' }), provision = createAuth({ database: store.database, mode: 'local', basePath, provisioning: true });
  const alice = await provision.createAccount({ username: 'alice', displayName: 'Alice', password: 'Private automation test password 1' });
  const bob = await provision.createAccount({ username: 'bob', displayName: 'Bob', password: 'Private automation test password 2' });
  const ci = await provision.createAccount({ username: 'ci-worker', displayName: 'CI', password: 'Private automation test password 3' });
  const app = createApp({ store, seed: false, authMode: 'password', basePath, automation: { managers: ['alice'], workers: ['ci-worker'] } });
  const tokens = { alice: app.auth.createToken(alice.id, { name: 'Alice', scopes: ['read', 'write'] }), bob: app.auth.createToken(bob.id, { name: 'Bob', scopes: ['read', 'write'] }), ci: app.auth.createToken(ci.id, { name: 'CI', scopes: ['read', 'write'] }), reader: app.auth.createToken(alice.id, { name: 'Reader', scopes: ['read'] }) };
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`; let sequence = 0;
  async function request<T>(path: string, method = 'GET', input?: unknown, actor: keyof typeof tokens = 'alice', key?: string) {
    const response = await fetch(`${origin}${basePath}${path.replace(/^\//, '')}`, { method, signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${tokens[actor].token}`, ...(input === undefined ? {} : { 'Content-Type': 'application/json' }), ...(method !== 'GET' ? { 'Idempotency-Key': key ?? `request-${++sequence}` } : {}) }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    return { status: response.status, body: await response.json() as T };
  }
  async function conduit<T>(method: string, params: Record<string, unknown>, actor: keyof typeof tokens = 'alice', key?: string, form = false) {
    const response = await fetch(`${origin}${basePath}api/${method}`, { method: 'POST', signal: AbortSignal.timeout(15_000), headers: { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, body: form ? new URLSearchParams({ params: JSON.stringify({ ...params, 'api.token': tokens[actor].token }) }) : JSON.stringify({ ...params, 'api.token': tokens[actor].token }) });
    assert.equal(response.status, 200); return await response.json() as ConduitEnvelope & { result: T | null };
  }
  function success<T>(result: ConduitEnvelope & { result: T | null }): T { assert.equal(result.error_code, null, JSON.stringify(result)); return result.result!; }
  async function plan(external = false) { const result = await request<{ plan: BuildPlan }>('/api/harbormaster/plans', 'POST', { name: 'CI plan', description: '', enabled: true, steps: [external ? externalStep : localStep] }); assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body.plan; }
  async function run(plan: BuildPlan) {
    const created = await request<RevisionDetail>('/api/revisions', 'POST', { kind: 'code', title: 'CI source', testPlan: 'Deterministic checks and external worker.', files: [{ path: 'main.ts', content: 'export const answer = 42;' }] }); assert.equal(created.status, 201, JSON.stringify(created.body));
    const version = created.body.versions[0]!;
    const result = await request<BuildDetail>('/api/harbormaster/builds', 'POST', { revisionId: created.body.revision.id, planId: plan.id, planVersion: plan.version, versionId: version.id, contentHash: version.contentHash }); assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body;
  }
  return { ...app, alice, bob, ci, tokens, request, conduit, success, plan, run, origin, basePath, close: async () => { await app.close(); store.close(); } };
}

test('Harbormaster Conduit searches share native source visibility and bind page cursors to query, reader and access epoch', async () => {
  const app = await start(); try {
    await app.plan(); const second = await app.plan(), third = await app.plan();
    const first = app.success(await app.conduit<Search>('harbormaster.buildplan.search', { limit: 1 }, 'alice', undefined, true));
    assert.equal(first.data[0]!.id, third.id); assert.equal(first.compatibility.identities, 'native'); assert.equal(first.compatibility.status, 'partial'); assert.ok(first.cursor.after);
    const next = app.success(await app.conduit<Search>('harbormaster.buildplan.search', { limit: 1, after: first.cursor.after })); assert.equal(next.data[0]!.id, second.id);
    assert.equal((await app.conduit('harbormaster.buildplan.search', { limit: 1, after: first.cursor.after }, 'bob')).error_code, 'ERR-CURSOR');
    assert.equal((await app.conduit('harbormaster.buildplan.search', { limit: 1, after: first.cursor.after, constraints: { statuses: ['active'] } })).error_code, 'ERR-CURSOR');
    const build = await app.run(third), result = app.success(await app.conduit<Search>('harbormaster.build.search', { constraints: { plans: [third.id] } })); assert.equal(result.data[0]!.id, build.build.id);
    for (const name of ['buildable', 'target', 'buildlog']) assert.equal(app.success(await app.conduit<Search>(`harbormaster.${name}.search`, {})).data.length, 1);
    assert.equal(app.success(await app.conduit<Search>('harbormaster.querybuilds', { buildPlanPHIDs: [third.id] })).data.length, 1);
    assert.equal(app.success(await app.conduit<Search>('harbormaster.querybuildables', { containerPHIDs: [build.buildable.revisionId] })).data.length, 1);
    const policy = app.policies.policy(build.buildable.revisionId!, app.alice.id);
    app.policies.setPolicy(build.buildable.revisionId!, { expectedVersion: policy.version, spaceId: policy.spaceId, ...policy.rules, view: { kind: 'principals', principalIds: [app.alice.id] } }, app.alice.id);
    assert.equal(app.success(await app.conduit<Search>('harbormaster.build.search', {}, 'bob')).data.length, 0);
    assert.equal((await app.conduit('harbormaster.buildplan.search', { after: first.cursor.after })).error_code, 'ERR-CURSOR');
  } finally { await app.close(); }
});

test('Conduit worker messages and URI artifacts require native leases, configured worker authority and durable retry keys', async () => {
  const app = await start('/workspace/'); try {
    const build = await app.run(await app.plan(true)), target = build.targets[0]!;
    const claimed = await app.request<BuildClaim>(`/api/harbormaster/targets/${target.id}/claim`, 'POST', { expectedVersion: target.version, worker: 'linux' }, 'ci'); assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
    const leaseToken = claimed.body.leaseToken;
    assert.ok((await app.conduit('harbormaster.sendmessage', { buildTargetPHID: target.id, type: 'pass' }, 'ci', 'missing-lease')).error_code);
    assert.ok((await app.conduit('harbormaster.sendmessage', { buildTargetPHID: target.id, type: 'pass', leaseToken, reportId: 'unconfigured' }, 'bob', 'unconfigured')).error_code);
    const artifact = { buildTargetPHID: target.id, leaseToken, reportId: 'artifact', artifactKey: 'result', artifactType: 'uri', artifactData: { uri: 'https://ci.example.test/result/1', name: 'Result', 'ui.external': true } };
    assert.ok((await app.conduit('harbormaster.createartifact', artifact, 'ci')).error_code, 'mutation needs retry identity');
    const created = app.success(await app.conduit<{ data: { id: string }[] }>('harbormaster.createartifact', artifact, 'ci', 'artifact'));
    assert.deepEqual(app.success(await app.conduit('harbormaster.createartifact', artifact, 'ci', 'artifact')), created);
    assert.equal(app.success(await app.conduit<Search>('harbormaster.artifact.search', { constraints: { buildTargetPHIDs: [target.id] } })).data[0]!.id, created.data[0]!.id);
    const message = { buildTargetPHID: target.id, leaseToken, reportId: 'finished', type: 'pass', unit: [{ name: 'build', result: 'pass' }], lint: [], log: 'External CI passed.' };
    const finished = app.success(await app.conduit<{ status: string }>('harbormaster.sendmessage', message, 'ci', 'finish', true)); assert.equal(finished.status, 'passed');
    assert.deepEqual(app.success(await app.conduit('harbormaster.sendmessage', message, 'ci', 'finish')), finished);
    assert.ok((await app.conduit('harbormaster.sendmessage', { ...message, type: 'fail' }, 'ci', 'finish')).error_code);
    app.auth.revokeToken(app.ci.id, app.tokens.ci.record.id);
    assert.equal((await app.conduit('harbormaster.sendmessage', message, 'ci', 'finish')).error_code, 'ERR-INVALID-AUTH');
  } finally { await app.close(); }
});

test('Conduit plan transactions preserve original version receipts and reject silent unsupported compatibility', async () => {
  const app = await start(); try {
    const create = { transactions: [{ type: 'name', value: 'Conduit plan' }, { type: 'steps', value: [localStep] }] };
    assert.equal((await app.conduit('harbormaster.buildplan.edit', create, 'reader', 'reader')).error_code, 'ERR-INVALID-AUTH');
    const created = app.success(await app.conduit<{ plan: BuildPlan }>('harbormaster.buildplan.edit', create, 'alice', 'create')).plan;
    const edit = { objectIdentifier: created.id, expectedVersion: 1, transactions: [{ type: 'name', value: 'Changed plan' }] };
    const saved = app.success(await app.conduit<{ plan: BuildPlan }>('harbormaster.buildplan.edit', edit, 'alice', 'edit'));
    assert.equal(saved.plan.version, 2);
    app.success(await app.conduit('harbormaster.buildplan.edit', { objectIdentifier: created.id, expectedVersion: 2, transactions: [{ type: 'description', value: 'Changed later' }] }, 'alice', 'later'));
    assert.deepEqual(app.success(await app.conduit('harbormaster.buildplan.edit', edit, 'alice', 'edit')), saved, 'retry returns original immutable edit receipt');
    assert.ok((await app.conduit('harbormaster.buildplan.edit', { ...edit, expectedVersion: 3 }, 'bob', 'owner-only')).error_code);
    assert.equal((await app.conduit('harbormaster.buildstep.edit', {}, 'alice', 'unsupported')).error_code, 'ERR-UNKNOWN-METHOD');
    assert.ok((await app.conduit('harbormaster.build.search', { constraints: { ids: [123] } })).error_code);
    assert.ok((await app.conduit('harbormaster.target.search', { attachments: { secrets: true } })).error_code);
  } finally { await app.close(); }
});

test('buildable search aggregates independent plans and excludes only explicitly superseded restart attempts', async () => {
  const app = await start(); try {
    const checks = await app.plan(), first = await app.run(checks), worker = await app.plan(true);
    const input = { revisionId: first.buildable.revisionId, versionId: first.buildable.versionId, contentHash: first.buildable.contentHash, planId: worker.id, planVersion: worker.version };
    const running = await app.request<BuildDetail>('/api/harbormaster/builds', 'POST', input); assert.equal(running.status, 201);
    const readStatus = async () => ((app.success(await app.conduit<Search>('harbormaster.buildable.search', { constraints: { ids: [first.buildable.id] } })).data[0]!.fields.buildableStatus) as { value: string }).value;
    assert.equal(await readStatus(), 'building');
    const target = running.body.targets[0]!, claim = await app.request<BuildClaim>(`/api/harbormaster/targets/${target.id}/claim`, 'POST', { expectedVersion: target.version, worker: 'linux' }, 'ci');
    const failed = await app.request<BuildDetail>(`/api/harbormaster/targets/${target.id}/report`, 'POST', { leaseToken: claim.body.leaseToken, reportId: 'failure', type: 'fail' }, 'ci'); assert.equal(failed.status, 200);
    const anotherPassed = await app.request<BuildDetail>('/api/harbormaster/builds', 'POST', { ...input, planId: checks.id, planVersion: checks.version }); assert.equal(anotherPassed.status, 201); assert.equal(await readStatus(), 'failed', 'a newer passing build must not hide an independent failed plan');
    const restarted = await app.request<BuildDetail>(`/api/harbormaster/builds/${failed.body.build.id}/commands`, 'POST', { command: 'restart', expectedVersion: failed.body.build.version }); assert.equal(restarted.status, 200); assert.equal(await readStatus(), 'building');
    const retriedTarget = restarted.body.targets[0]!, retriedClaim = await app.request<BuildClaim>(`/api/harbormaster/targets/${retriedTarget.id}/claim`, 'POST', { expectedVersion: retriedTarget.version, worker: 'linux' }, 'ci');
    const passed = await app.request<BuildDetail>(`/api/harbormaster/targets/${retriedTarget.id}/report`, 'POST', { leaseToken: retriedClaim.body.leaseToken, reportId: 'pass', type: 'pass' }, 'ci'); assert.equal(passed.status, 200); assert.equal(await readStatus(), 'passed');
  } finally { await app.close(); }
});
