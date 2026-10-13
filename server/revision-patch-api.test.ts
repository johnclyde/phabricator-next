import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import test from 'node:test';
import type { DrydockAuthorization, DrydockBlueprint, DrydockBlueprintDetail, DrydockClaim, DrydockLease, DrydockLeaseDetail, DrydockResource } from '../shared/drydock.ts';
import type { BuildClaim, BuildDetail, BuildPlan } from '../shared/harbormaster.ts';
import type { RevisionPatchIdentity } from '../shared/revision-patch.ts';
import type { RevisionDetail } from '../shared/types.ts';
import { createGitFixture } from '../tests/git-fixture.ts';
import { createApp } from './app.ts';
import { createAuth } from './auth.ts';
import type { AutomationConfiguration } from './automation.ts';
import { LocalDrydockWorker, parseDrydockWorkerConfiguration, runDrydockWorkerCycle } from './drydock-worker.ts';
import { Store } from './store.ts';

const members = (...principalIds: string[]) => ({ kind: 'principals' as const, principalIds });
async function setup(kind: 'code' | 'paper' | 'document' = 'code', sourceOwner: 'alice' | 'bob' = 'alice') {
  const git = await createGitFixture(), store = new Store({ path: ':memory:' });
  const provisioning = createAuth({ database: store.database, mode: 'local', basePath: '/', provisioning: true });
  const alice = await provisioning.createAccount({ username: 'alice', displayName: 'Revision owner', password: 'Owner revision patch fixture password' });
  const bob = await provisioning.createAccount({ username: 'bob', displayName: 'Revision worker', password: 'Worker revision patch fixture password' });
  const configuration: AutomationConfiguration = { managers: ['alice'], workers: ['bob'], drydockBindings: [{ key: 'review-copy', worker: 'review-worker', repositoryIds: ['R1'] }], drydockWorkers: { 'review-worker': ['bob'] } };
  const app = createApp({ store, seed: false, authMode: 'password', gitRepositories: { R1: git.barePath }, automation: configuration });
  await app.automation.close();
  store.createRepository({ name: 'Review source', remoteUrl: 'https://example.invalid/review.git' });
  const tokens = {
    alice: app.auth.createToken(alice.id, { name: 'Owner', scopes: ['read', 'write'] }).token,
    bob: app.auth.createToken(bob.id, { name: 'Worker', scopes: ['read', 'write'] }).token,
    reader: app.auth.createToken(bob.id, { name: 'Read only', scopes: ['read'] }).token,
  };
  await new Promise<void>(accept => app.server.listen(0, '127.0.0.1', accept));
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  async function request<T>(path: string, method = 'GET', input?: unknown, who: keyof typeof tokens = 'alice', key = randomUUID()) {
    const response = await fetch(origin + path, { method, signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${tokens[who]}`, ...(input === undefined ? {} : { 'Content-Type': 'application/json' }), ...(method === 'GET' ? {} : { 'Idempotency-Key': key }) }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    return { status: response.status, body: await response.json() as T };
  }
  const imported = await request<RevisionDetail>('/api/repositories/R1/import-revision', 'POST', { commitId: git.importCommit, kind, title: 'Immutable revision patch', testPlan: 'Verify exact source and cleanup.' }, sourceOwner);
  assert.equal(imported.status, 201, JSON.stringify(imported.body));
  const revisionId = imported.body.revision.id, baseline = imported.body.versions[0]!;
  const edited = await request<RevisionDetail>(`/api/revisions/${revisionId}/versions`, 'POST', { expectedVersion: 1, message: 'Reviewed patch', files: baseline.files.filter(file => file.path !== 'name with spaces.md').map(file => ({ ...file, content: file.path === 'docs/paper.tex' ? '\\section{Reviewed result}\r\nExact immutable text.\n' : file.content })) });
  assert.equal(edited.status, 201, JSON.stringify(edited.body));
  const source = edited.body.versions.find(version => version.number === 2)!;
  const created = await request<{ blueprint: DrydockBlueprint }>('/api/drydock/blueprints', 'POST', { name: 'Revision copies', description: '', enabled: true, repositoryId: 'R1', binding: 'review-copy', worker: 'review-worker', limit: 4 });
  assert.equal(created.status, 201, JSON.stringify(created.body)); const blueprint = created.body.blueprint;
  async function authorize(subjectKind: 'principal' | 'build-plan', subjectId: string) {
    const response = await request<{ authorization: DrydockAuthorization }>(`/api/drydock/blueprints/${blueprint.id}/authorizations`, 'POST', { subjectKind, subjectId });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const decision = await request(`/api/drydock/authorizations/${response.body.authorization.id}/commands`, 'POST', { expectedVersion: response.body.authorization.version, status: 'approved' }); assert.equal(decision.status, 200, JSON.stringify(decision.body));
  }
  await authorize('principal', alice.id);
  const actor = (who: 'alice' | 'bob') => ({ principalId: who === 'alice' ? alice.id : bob.id, displayName: who === 'alice' ? alice.displayName : bob.displayName, workspaceId: app.auth.workspaceId });
  const leaseInput = { revisionId, versionId: source.id, contentHash: source.contentHash, blueprintId: blueprint.id, blueprintVersion: blueprint.version };
  const patchPath = `/api/drydock/revision-patches/${revisionId}?versionId=${source.id}&contentHash=${source.contentHash}`;
  const policy = (objectId: string, changes: Record<string, unknown>, who: 'alice' | 'bob' = 'alice') => {
    const principalId = actor(who).principalId, current = app.policies.policy(objectId, principalId);
    app.policies.setPolicy(objectId, { expectedVersion: current.version, spaceId: current.spaceId, ...current.rules, ...changes }, principalId);
  };
  async function allocate() { const result = await request<DrydockLeaseDetail>('/api/drydock/leases', 'POST', leaseInput); assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body; }
  async function claim(lease: DrydockLeaseDetail) {
    const path = `/api/drydock/leases/${lease.lease.id}/claim`, input = { expectedVersion: lease.lease.version, worker: 'review-worker' }, key = randomUUID();
    const response = await request<DrydockClaim>(path, 'POST', input, 'bob', key); assert.equal(response.status, 200, JSON.stringify(response.body)); return { claim: response.body, replay: () => request<DrydockClaim>(path, 'POST', input, 'bob', key) };
  }
  async function build() {
    const created = await request<{ plan: BuildPlan }>('/api/harbormaster/plans', 'POST', { name: 'Review build', description: '', enabled: true, steps: [{ key: 'copy', name: 'Reviewed working copy', kind: 'working-copy', dependsOn: [], worker: 'review-worker', blueprintId: blueprint.id }, { key: 'test', name: 'External tests', kind: 'external', dependsOn: ['copy'], worker: 'review-worker' }] });
    assert.equal(created.status, 201, JSON.stringify(created.body)); const plan = created.body.plan; await authorize('build-plan', plan.id);
    const input = { revisionId, versionId: source.id, contentHash: source.contentHash, planId: plan.id, planVersion: plan.version }, key = randomUUID();
    const result = await request<BuildDetail>('/api/harbormaster/builds', 'POST', input, 'alice', key); assert.equal(result.status, 201, JSON.stringify(result.body));
    return { detail: result.body, replay: () => request<BuildDetail>('/api/harbormaster/builds', 'POST', input, 'alice', key) };
  }
  const worker = new LocalDrydockWorker(parseDrydockWorkerConfiguration({ server: origin, worker: 'review-worker', bindings: { 'review-copy': { repositoryId: 'R1', repositoryPath: git.barePath, root: join(await realpath(git.root), 'review-worker') } } }));
  return { ...app, git, alice, bob, tokens, configuration, actor, origin, source, revisionId, baseline, blueprint, leaseInput, patchPath, request, policy, allocate, claim, build, worker, close: async () => { await app.close(); store.close(); await git.close(); } };
}

test('revision working-copy builds provision exact paper source through the real API and clean up after worker results', async () => {
  const app = await setup('paper');
  try {
    const { detail: build } = await app.build(); assert.ok(app.revisionId.startsWith('P'));
    assert.equal(build.buildable.revisionPatch!.versionId, app.source.id);
    const leaseId = build.targets.find(target => target.stepKey === 'copy')!.drydockLeaseId!;
    await runDrydockWorkerCycle(app.worker, app.tokens.bob);
    app.automation.harbormaster.reconcileWorkingCopies();
    const ready = await app.request<BuildDetail>(`/api/harbormaster/builds/${build.build.id}`); assert.equal(ready.status, 200);
    assert.equal(ready.body.targets.find(target => target.stepKey === 'copy')!.status, 'passed');
    const target = ready.body.targets.find(target => target.stepKey === 'test')!, path = `/api/harbormaster/targets/${target.id}/claim`, input = { expectedVersion: target.version, worker: 'review-worker' }, key = randomUUID();
    const claimed = await app.request<BuildClaim>(path, 'POST', input, 'bob', key); assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
    assert.deepEqual(claimed.body.source!.files, app.source.files); assert.equal(claimed.body.workingCopies!.length, 1);
    assert.deepEqual((await app.request(path, 'POST', input, 'bob', key)).body, claimed.body);
    const copy = claimed.body.workingCopies![0]!, work = join(app.worker.configuration.bindings['review-copy']!.root, copy.handle, 'work');
    assert.equal(await readFile(join(work, 'docs/paper.tex'), 'utf8'), '\\section{Reviewed result}\r\nExact immutable text.\n');
    await assert.rejects(stat(join(work, 'name with spaces.md')));
    assert.equal((await readFile(join(work, '.git', 'HEAD'), 'utf8')).trim(), app.git.importCommit);
    const updated = await app.request(`/api/revisions/${app.revisionId}/versions`, 'POST', { expectedVersion: 2, message: 'Later source', files: [{ path: 'later.tex', content: 'Unrelated later version\n' }] }); assert.equal(updated.status, 201);
    const reported = await app.request<BuildDetail>(`/api/harbormaster/targets/${target.id}/report`, 'POST', { leaseToken: claimed.body.leaseToken, reportId: 'verified-source', type: 'pass', log: 'Exact reviewed version passed.' }, 'bob');
    assert.equal(reported.status, 200, JSON.stringify(reported.body)); assert.equal(reported.body.build.status, 'passed'); assert.equal(reported.body.buildable.versionId, app.source.id);
    assert.equal((await app.request(path, 'POST', input, 'bob', key)).status, 409, 'finished targets do not revive saved claim capabilities');
    await runDrydockWorkerCycle(app.worker, app.tokens.bob);
    const released = await app.request<DrydockLeaseDetail>(`/api/drydock/leases/${leaseId}`); assert.equal(released.body.lease.status, 'released'); await assert.rejects(stat(work));
  } finally { await app.close(); }
});

test('revision patch inspection and allocation enforce exact input identities and read/write scopes', async () => {
  const app = await setup('document');
  try {
    const result = await app.request<{ revisionPatch: RevisionPatchIdentity }>(app.patchPath, 'GET', undefined, 'reader'); assert.equal(result.status, 200, JSON.stringify(result.body)); assert.ok(app.revisionId.startsWith('L'));
    assert.equal(result.body.revisionPatch.contentHash, app.source.contentHash); assert.equal('files' in result.body, false);
    for (const path of [app.patchPath + '&versionId=other', app.patchPath + '&contentHash=other', app.patchPath + '&extra=value']) assert.equal((await app.request(path)).status, 400);
    assert.equal((await app.request(`/api/drydock/revision-patches/${app.revisionId}?versionId=${app.source.id}`)).status, 400);
    assert.equal((await app.request('/api/drydock/leases', 'POST', app.leaseInput, 'reader')).status, 403);
    for (const input of [{ ...app.leaseInput, contentHash: 'f'.repeat(64) }, { ...app.leaseInput, versionId: 'foreign-version' }, { ...app.leaseInput, patch: {} }, { ...app.leaseInput, repositoryId: 'R1', commitId: app.git.importCommit }]) assert.ok([400, 409, 422].includes((await app.request('/api/drydock/leases', 'POST', input)).status));
    assert.equal(app.store.database.prepare('SELECT count(*) AS count FROM drydock_leases').get()!.count, 0);
  } finally { await app.close(); }
});

for (const object of ['revision', 'repository'] as const) test(`Drydock revision claims and all read projections require current ${object} visibility`, async () => {
  const app = await setup();
  try {
    const allocated = await app.allocate(), { claim, replay } = await app.claim(allocated);
    assert.equal(claim.patch!.versionId, app.source.id); assert.deepEqual(claim.lease.source.revisionPatch, claim.resource.source.revisionPatch);
    app.policy(object === 'revision' ? app.revisionId : 'R1', { view: members(app.alice.id), edit: members(app.alice.id), interact: members(app.alice.id) });
    const repeated = await replay(); assert.ok([403, 404].includes(repeated.status)); assert.equal(JSON.stringify(repeated.body).includes('Exact immutable text.'), false); assert.equal('token' in repeated.body, false);
    for (const path of [app.patchPath, `/api/drydock/leases/${claim.lease.id}`, `/api/drydock/resources/${claim.resource.id}`]) assert.equal((await app.request(path, 'GET', undefined, 'bob')).status, 404);
    assert.deepEqual((await app.request<{ leases: DrydockLease[] }>('/api/drydock/leases', 'GET', undefined, 'bob')).body.leases, []);
    assert.deepEqual((await app.request<{ resources: DrydockResource[] }>('/api/drydock/resources', 'GET', undefined, 'bob')).body.resources, []);
    if (object === 'revision') { const projected = await app.request<DrydockBlueprintDetail>(`/api/drydock/blueprints/${app.blueprint.id}`, 'GET', undefined, 'bob'); assert.equal(projected.status, 200); assert.deepEqual(projected.body.leases, []); assert.deepEqual(projected.body.resources, []); }
    app.automation.drydock.sweep();
    const cleanup = await app.request<{ jobs: DrydockLeaseDetail[] }>('/api/drydock/worker/jobs?worker=review-worker', 'GET', undefined, 'bob'); assert.equal(cleanup.status, 200); assert.equal(cleanup.body.jobs.length, 1);
    const released = await app.request<DrydockClaim>(`/api/drydock/leases/${claim.lease.id}/claim`, 'POST', { expectedVersion: cleanup.body.jobs[0]!.lease.version, worker: 'review-worker' }, 'bob'); assert.equal(released.status, 200); assert.equal(released.body.operation, 'release'); assert.equal(released.body.patch, undefined);
  } finally { await app.close(); }
});

for (const revoked of ['holder', 'worker'] as const) test(`Drydock claim replay rejects withdrawn ${revoked} revision edit permission`, async () => {
  const app = await setup('code', revoked === 'holder' ? 'bob' : 'alice');
  try {
    const { replay } = await app.claim(await app.allocate());
    app.policy(app.revisionId, { edit: members(revoked === 'worker' ? app.alice.id : app.bob.id) }, revoked === 'holder' ? 'bob' : 'alice');
    const result = await replay(); assert.equal(result.status, 403); assert.equal('patch' in result.body, false);
    app.automation.drydock.sweep(); assert.equal((await app.request<{ jobs: DrydockLeaseDetail[] }>('/api/drydock/worker/jobs?worker=review-worker', 'GET', undefined, 'bob')).body.jobs[0]!.lease.status, 'releasing');
  } finally { await app.close(); }
});

test('revision-patch build metadata, mutation receipts and controls require repository access as well as revision access', async () => {
  const app = await setup();
  try {
    const { detail: build, replay } = await app.build();
    app.policy('R1', { edit: members(app.bob.id) }, 'bob');
    const readonly = await app.request<BuildDetail & { canManage: boolean }>(`/api/harbormaster/builds/${build.build.id}`); assert.equal(readonly.status, 200); assert.equal(readonly.body.canManage, false);
    assert.equal((await app.request(`/api/harbormaster/builds/${build.build.id}/commands`, 'POST', { command: 'abort', expectedVersion: build.build.version })).status, 403);
    app.policy('R1', { view: members(app.bob.id), edit: members(app.bob.id), interact: members(app.bob.id) }, 'bob');
    assert.equal((await app.request(`/api/harbormaster/builds/${build.build.id}`)).status, 404);
    assert.deepEqual((await app.request<{ builds: unknown[] }>('/api/harbormaster/builds')).body.builds, []);
    assert.equal((await app.request(`/api/harbormaster/builds?revisionId=${app.revisionId}`)).status, 404);
    assert.equal((await replay()).status, 404);
    assert.equal((await app.request(`/api/harbormaster/builds/${build.build.id}/commands`, 'POST', { command: 'abort', expectedVersion: build.build.version })).status, 404);
  } finally { await app.close(); }
});

for (const change of ['revision-edit', 'repository-edit', 'copy-released', 'target-expired'] as const) test(`Harbormaster claim replay does not revive revision working copies after ${change}`, async () => {
  const app = await setup();
  try {
    const { detail: build } = await app.build(); await runDrydockWorkerCycle(app.worker, app.tokens.bob); app.automation.harbormaster.reconcileWorkingCopies();
    const ready = (await app.request<BuildDetail>(`/api/harbormaster/builds/${build.build.id}`)).body, target = ready.targets.find(item => item.stepKey === 'test')!, path = `/api/harbormaster/targets/${target.id}/claim`, input = { expectedVersion: target.version, worker: 'review-worker' }, key = randomUUID();
    const claimed = await app.request<BuildClaim>(path, 'POST', input, 'bob', key); assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
    if (change === 'revision-edit' || change === 'repository-edit') app.policy(change === 'revision-edit' ? app.revisionId : 'R1', { edit: members(app.alice.id) });
    else if (change === 'target-expired') app.store.database.prepare('UPDATE harbormaster_targets SET lease_until=? WHERE id=?').run(Date.now() - 1, target.id);
    else { const copy = claimed.body.workingCopies![0]!, detail = app.automation.drydock.detail(copy.leaseId, app.actor('alice')); app.automation.drydock.command(copy.leaseId, { command: 'release', expectedVersion: detail.lease.version }, app.actor('alice')); }
    const result = await app.request<BuildClaim>(path, 'POST', input, 'bob', key); assert.ok([403, 409].includes(result.status), JSON.stringify(result.body)); assert.equal('workingCopies' in result.body, false); assert.equal('leaseToken' in result.body, false);
  } finally { await app.close(); }
});
