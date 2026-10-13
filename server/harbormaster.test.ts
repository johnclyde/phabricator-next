import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HarbormasterStore, initializeHarbormaster, type BuildActor, type BuildAuthority, type HarbormasterHooks } from './harbormaster.ts';
import { HttpError } from './validation.ts';
import { aggregateBuildableStatus, buildPlanInput, buildReportInput, type BuildDetail, type BuildPlan, type BuildPlanInput, type BuildStep } from '../shared/harbormaster.ts';
import { sourceSnapshotCanonical } from '../shared/source-snapshot.ts';
import type { RevisionVersion } from '../shared/types.ts';
import type { GitCommitResult } from '../shared/repositories.ts';
import type { GitReviewRevision } from '../shared/git-review-gates.ts';

const alice: BuildActor = { principalId: 'alice', workspaceId: 'workspace', displayName: 'Alice' };
const bob: BuildActor = { principalId: 'bob', workspaceId: 'workspace', displayName: 'Bob' };
const ci: BuildActor = { principalId: 'ci', workspaceId: 'workspace', displayName: 'CI' };
const local = (key = 'check', dependsOn: string[] = []): BuildStep => ({ key, name: key, kind: 'local-checks', dependsOn, worker: null });
const external = (key = 'test', dependsOn: string[] = []): BuildStep => ({ key, name: key, kind: 'external', dependsOn, worker: 'linux' });
const http = (key = 'dispatch', dependsOn: string[] = []): BuildStep => ({ key, name: key, kind: 'http', dependsOn, worker: 'http-ci', endpoint: 'https://ci.example.test/jobs', });
const planInput = (steps: BuildStep[] = [local()]): BuildPlanInput => ({ name: 'Test plan', description: 'Build the exact immutable input.', enabled: true, steps });
function source(content = 'const answer = 42;'): RevisionVersion {
  const files = [{ path: 'main.ts', content }];
  return { id: 'version-1', revisionId: 'D1', number: 1, files, message: 'Original', contentHash: createHash('sha256').update(sourceSnapshotCanonical(files)).digest('hex'), createdAt: '2026-01-01T00:00:00.000Z' };
}
function fixture(options: { path?: string; source?: RevisionVersion; http?: boolean; httpActor?: boolean } = {}) {
  let now = Date.parse('2026-01-01T01:00:00.000Z'), version = options.source ?? source();
  const revoked = new Set<string>(), hidden = new Set<string>(), denied = new Set<string>();
  const db = new DatabaseSync(options.path ?? ':memory:'); db.exec('PRAGMA foreign_keys=ON'); initializeHarbormaster(db);
  const hooks: HarbormasterHooks = {
    authorize(actor, id, write) { if (revoked.has(actor.principalId)) throw new HttpError(401, 'Revoked.'); if (id && hidden.has(`${actor.principalId}:${id}`)) throw new HttpError(404, 'Hidden.'); if (write && denied.has(actor.principalId)) throw new HttpError(403, 'Read only.'); },
    source(id, versionId, contentHash) { if (id !== version.revisionId || versionId !== version.id || contentHash !== version.contentHash) throw new HttpError(409, 'Unknown exact source.'); return { version, kind: 'code' }; },
    ...(options.http ? { allowHttp(endpoint: string) { if (endpoint !== 'https://ci.example.test/jobs') throw new HttpError(403, 'Endpoint is not configured.'); } } : {}),
    ...(options.httpActor ? { httpActor() { return ci; } } : {}),
  };
  const service = new HarbormasterStore(db, hooks, () => now);
  const run = (plan: BuildPlan, actor: BuildAuthority = alice) => service.run('D1', { planId: plan.id, planVersion: plan.version, versionId: version.id, contentHash: version.contentHash }, actor);
  const claim = (detail: BuildDetail, key = 'test', actor: BuildAuthority = ci) => { const target = detail.targets.find(item => item.stepKey === key)!; return service.claim({ targetId: target.id, expectedVersion: target.version, worker: detail.build.plan.steps.find(item => item.key === key)!.worker }, actor); };
  return { db, service, hooks, revoked, hidden, denied, run, claim, version: () => version, replaceSource: (value: RevisionVersion) => { version = value; }, advance: (milliseconds: number) => { now += milliseconds; }, close: () => db.close() };
}

test('push build gates require exact revision versions, current enabled plans, and all independent runs', () => {
  const f = fixture(); try {
    const commit: GitCommitResult = { repositoryId: 'R1', objectFormat: 'sha1', commit: { id: 'a'.repeat(40), treeId: 'b'.repeat(40), parentIds: [], author: { name: 'A', email: 'a@example.test', timestamp: '2026-01-01T00:00:00Z' }, committer: { name: 'A', email: 'a@example.test', timestamp: '2026-01-01T00:00:00Z' }, message: 'Commit', messageTruncated: false } };
    const revision: GitReviewRevision = { revisionId: 'D1', versionId: f.version().id, versionNumber: 1, contentHash: f.version().contentHash, targetTreeId: commit.commit.treeId, accepted: true, lifecycleVersion: 1, reviewerVersion: 1, evidenceSha256: 'f'.repeat(64) };
    const initial = f.service.createPlan(planInput(), alice), gate = () => f.service.reviewGateBuilds(commit, revision).find(plan => plan.planId === initial.id)!;
    assert.equal(gate().status, 'missing'); const passed = f.run(initial); assert.equal(gate().status, 'passed'); assert.deepEqual(gate().builds.map(build => build.id), [passed.build.id]);
    assert.equal(f.service.reviewGateBuilds(commit, { ...revision, versionId: 'newer-version' })[0]!.status, 'missing');
    assert.equal(f.service.reviewGateBuilds(commit, { ...revision, contentHash: 'e'.repeat(64) })[0]!.status, 'missing');
    const changed = f.service.updatePlan(initial.id, { ...planInput([external()]), expectedVersion: 1 }, alice);
    assert.equal(gate().status, 'stale'); const pending = f.run(changed); assert.equal(gate().status, 'pending');
    const claim = f.claim(pending); assert.equal(gate().status, 'building');
    f.service.report(claim.target.id, { leaseToken: claim.leaseToken, reportId: 'failed', type: 'fail' }, ci); assert.equal(gate().status, 'failed');
    const independent = f.run(changed), independentClaim = f.claim(independent);
    f.service.report(independentClaim.target.id, { leaseToken: independentClaim.leaseToken, reportId: 'passed', type: 'pass' }, ci); assert.equal(gate().status, 'failed', 'an independent pass cannot erase the failed run');
    const current = f.service.detail(pending.build.id, alice);
    const restarted = f.service.command(current.build.id, { command: 'restart', expectedVersion: current.build.version }, alice), retry = f.claim(restarted);
    f.service.report(retry.target.id, { leaseToken: retry.leaseToken, reportId: 'retry-pass', type: 'pass' }, ci); assert.equal(gate().status, 'passed'); assert.equal(gate().builds.length, 2);
    f.service.updatePlan(initial.id, { ...planInput([external()]), enabled: false, expectedVersion: 2 }, alice); assert.equal(gate().status, 'disabled');
  } finally { f.close(); }
});

test('push build gates distinguish exact commits from same-tree commits in other repositories or histories', () => {
  const f = fixture(); try {
    const commit: GitCommitResult = { repositoryId: 'R1', objectFormat: 'sha1', commit: { id: 'a'.repeat(40), treeId: 'b'.repeat(40), parentIds: [], author: { name: 'A', email: 'a@example.test', timestamp: '2026-01-01T00:00:00Z' }, committer: { name: 'A', email: 'a@example.test', timestamp: '2026-01-01T00:00:00Z' }, message: 'Commit', messageTruncated: false } };
    const plan = f.service.createPlan(planInput([external()]), alice), build = f.service.runCommit(commit, { planId: plan.id, planVersion: plan.version }, alice), claim = f.claim(build);
    f.service.report(claim.target.id, { leaseToken: claim.leaseToken, reportId: 'commit-pass', type: 'pass' }, ci);
    const exact = f.service.reviewGateBuilds(commit, null)[0]!; assert.equal(exact.status, 'passed'); assert.equal(exact.builds[0]!.sourceKind, 'commit');
    for (const wrong of [{ ...commit, repositoryId: 'R2' }, { ...commit, commit: { ...commit.commit, id: 'c'.repeat(40) } }, { ...commit, commit: { ...commit.commit, treeId: 'c'.repeat(40) } }]) assert.equal(f.service.reviewGateBuilds(wrong, null)[0]!.status, 'missing');
  } finally { f.close(); }
});

test('build plan validation rejects duplicate, missing and cyclic dependencies without recursive graph traversal', () => {
  assert.deepEqual(buildPlanInput(planInput()), planInput());
  assert.throws(() => buildPlanInput(planInput([local('a'), local('a')])), /unique/);
  assert.throws(() => buildPlanInput(planInput([local('a', ['missing'])])), /other steps/);
  assert.throws(() => buildPlanInput(planInput([local('a', ['b']), local('b', ['a'])])), /cycle/);
  assert.throws(() => buildPlanInput(planInput([{ ...http(), endpoint: 'https://user:secret@ci.example.test/jobs' }])), /without credentials/);
  assert.throws(() => buildPlanInput({ ...planInput(), shell: 'curl example.test' }), /fields/);
  const steps = Array.from({ length: 2_048 }, (_, index) => local(`step-${index}`, index ? [`step-${index - 1}`] : []));
  assert.equal(buildPlanInput(planInput(steps)).steps.length, 2_048);
});

test('initialization rejects incompatible existing Harbormaster tables', () => {
  const db = new DatabaseSync(':memory:');
  try { db.exec('CREATE TABLE harbormaster_plans(id TEXT PRIMARY KEY,data TEXT,unexpected TEXT)'); assert.throws(() => initializeHarbormaster(db), /Unexpected harbormaster_plans schema/); }
  finally { db.close(); }
});

test('buildable aggregation includes every independent plan and only the current attempts of restarted builds', () => {
  const passed = { id: 'pass', status: 'passed' as const, restartOf: null }, failed = { id: 'fail', status: 'failed' as const, restartOf: null }, building = { id: 'build', status: 'building' as const, restartOf: null };
  assert.equal(aggregateBuildableStatus([]), 'preparing');
  assert.equal(aggregateBuildableStatus([passed]), 'passed');
  assert.equal(aggregateBuildableStatus([passed, building]), 'building');
  assert.equal(aggregateBuildableStatus([passed, failed, building]), 'failed');
  assert.equal(aggregateBuildableStatus([passed, { ...building, status: 'paused' }]), 'building');
  assert.equal(aggregateBuildableStatus([passed, failed, { id: 'retry', restartOf: 'fail', status: 'passed' }]), 'passed');
  assert.equal(aggregateBuildableStatus([passed, failed, { id: 'retry', restartOf: 'fail', status: 'failed' }, { id: 'retry-again', restartOf: 'retry', status: 'building' }]), 'building');
  assert.equal(aggregateBuildableStatus([failed, { id: 'independent', restartOf: null, status: 'passed' }]), 'failed');
});

test('plan history is immutable, updates require exact version and owner authority', () => {
  const f = fixture(); try {
    const plan = f.service.createPlan(planInput(), alice);
    assert.throws(() => f.service.updatePlan(plan.id, { ...planInput(), expectedVersion: 1 }, bob), /owner/);
    const changed = f.service.updatePlan(plan.id, { ...planInput([external()]), expectedVersion: 1 }, alice);
    assert.equal(changed.version, 2); assert.equal(f.service.plan(plan.id, bob).steps[0]!.kind, 'external');
    assert.throws(() => f.service.updatePlan(plan.id, { ...planInput(), expectedVersion: 1 }, alice), /changed/);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM harbormaster_plan_versions').get()!.n, 2);
    assert.throws(() => f.db.prepare('DELETE FROM harbormaster_plan_versions').run(), /immutable/);
    assert.throws(() => f.run(plan), /changed/);
  } finally { f.close(); }
});

test('deterministic checks pin immutable source and apply dependency success or failure', () => {
  const f = fixture(); try {
    const result = f.run(f.service.createPlan(planInput([local('first'), local('second', ['first'])]), alice));
    assert.equal(result.build.status, 'passed'); assert.equal(result.reports.length, 2); assert.equal(result.buildable.contentHash, f.version().contentHash);
    assert.equal(result.targets.every(target => target.status === 'passed'), true); assert.match(result.reports[0]!.log, /Local text checks/);
    assert.equal(result.buildable.sourceKind, 'revision');
  } finally { f.close(); }
  const bad = fixture({ source: source('<<<<<<< unresolved\n') }); try {
    const result = bad.run(bad.service.createPlan(planInput([local(), external('downstream', ['check'])]), alice));
    assert.equal(result.build.status, 'failed'); assert.deepEqual(result.targets.map(target => target.status), ['failed', 'aborted']); assert.equal(result.reports[0]!.lint[0]!.severity, 'error');
  } finally { bad.close(); }
});

test('parallel branches, pause and resume gate scheduling while allowing an in-flight result', () => {
  const f = fixture(); try {
    const result = f.run(f.service.createPlan(planInput([external('left'), external('right'), local('join', ['left', 'right'])]), alice));
    const claim = f.claim(result, 'left'), current = f.service.detail(result.build.id, alice);
    const paused = f.service.command(result.build.id, { command: 'pause', expectedVersion: current.build.version }, alice);
    assert.throws(() => f.claim(paused, 'right'), /not accepting/);
    const reported = f.service.report(claim.target.id, { leaseToken: claim.leaseToken, reportId: 'left', type: 'pass' }, ci);
    assert.equal(reported.build.status, 'paused'); assert.equal(reported.targets.find(t => t.stepKey === 'join')!.status, 'blocked');
    const resumed = f.service.command(result.build.id, { command: 'resume', expectedVersion: reported.build.version }, alice), right = f.claim(resumed, 'right');
    const finished = f.service.report(right.target.id, { leaseToken: right.leaseToken, reportId: 'right', type: 'pass' }, ci);
    assert.equal(finished.build.status, 'passed'); assert.equal(finished.targets.find(t => t.stepKey === 'join')!.status, 'passed');
  } finally { f.close(); }
});

test('leases fence competing workers, source changes, expiration and stale attempt callbacks', () => {
  const f = fixture(); try {
    const initial = f.run(f.service.createPlan(planInput([external()]), alice)), first = f.claim(initial);
    assert.throws(() => f.claim(initial), /changed/);
    assert.throws(() => f.service.report(first.target.id, { leaseToken: first.leaseToken, reportId: 'wrong', type: 'pass' }, bob), /another worker/);
    f.advance(5 * 60_000 + 1);
    assert.throws(() => f.service.report(first.target.id, { leaseToken: first.leaseToken, reportId: 'late', type: 'pass' }, ci), /expired/);
    const second = f.claim(f.service.detail(initial.build.id, ci)); assert.equal(second.target.attempt, 2);
    assert.throws(() => f.service.report(first.target.id, { leaseToken: first.leaseToken, reportId: 'late', type: 'pass' }, ci), /expired/);
    const old = f.version(); f.replaceSource({ ...old, files: [{ path: 'main.ts', content: 'tampered' }] });
    assert.throws(() => f.service.report(second.target.id, { leaseToken: second.leaseToken, reportId: 'tamper', type: 'pass' }, ci), /immutable build source/);
    f.replaceSource(old);
    const done = f.service.report(second.target.id, { leaseToken: second.leaseToken, reportId: 'done', type: 'pass' }, ci); assert.equal(done.build.status, 'passed');
  } finally { f.close(); }
});

test('reports retain immutable logs, unit, lint and artifacts; identical retries do not duplicate evidence', () => {
  const f = fixture(); try {
    const initial = f.run(f.service.createPlan(planInput([external()]), alice)), claim = f.claim(initial);
    const report = { leaseToken: claim.leaseToken, reportId: 'progress', type: 'work' as const, log: 'Compiling\n', unit: [{ name: 'first', result: 'pass' as const, duration: 0.1 }], lint: [{ name: 'Style', code: 'W1', severity: 'warning' as const, path: 'main.ts', line: 1 }], artifacts: [{ key: 'log', name: 'Build log', uri: 'https://ci.example.test/logs/1' }] };
    f.service.report(claim.target.id, report, ci); f.service.report(claim.target.id, report, ci);
    assert.throws(() => f.service.report(claim.target.id, { ...report, log: 'different' }, ci), /different contents/);
    assert.throws(() => f.service.report(claim.target.id, { ...report, reportId: 'artifact-duplicate' }, ci), /artifact with this key/);
    assert.equal(f.service.detail(initial.build.id, ci).reports.length, 1, 'failed artifact write rolls back its accompanying report');
    const finish = { leaseToken: claim.leaseToken, reportId: 'finish', type: 'fail' as const, log: 'Compiler failed.' };
    const done = f.service.report(claim.target.id, finish, ci); f.service.report(claim.target.id, finish, ci);
    assert.equal(done.build.status, 'failed'); assert.equal(done.reports.length, 2); assert.equal(done.artifacts.length, 1); assert.equal(done.reports[0]!.unit[0]!.name, 'first');
    for (const table of ['harbormaster_reports', 'harbormaster_events', 'harbormaster_artifacts']) assert.throws(() => f.db.prepare(`UPDATE ${table} SET data='{}'`).run(), /immutable/);
    assert.equal(JSON.stringify(done).includes(claim.leaseToken), false);
  } finally { f.close(); }
});

test('work messages extend leases, abort invalidates unfinished attempts, and restart freezes original plan and source', () => {
  const f = fixture(); try {
    const plan = f.service.createPlan(planInput([external()]), alice), initial = f.run(plan), claim = f.claim(initial);
    f.advance(4 * 60_000);
    const progress = f.service.report(claim.target.id, { leaseToken: claim.leaseToken, reportId: 'work', type: 'work' }, ci);
    assert.ok(Date.parse(progress.targets[0]!.leaseUntil!) > Date.parse(claim.leaseUntil));
    const aborted = f.service.command(initial.build.id, { command: 'abort', expectedVersion: progress.build.version }, alice);
    assert.throws(() => f.service.report(claim.target.id, { leaseToken: claim.leaseToken, reportId: 'late', type: 'pass' }, ci), /expired/);
    f.service.updatePlan(plan.id, { ...planInput([local()]), enabled: false, expectedVersion: 1 }, alice);
    const restarted = f.service.command(initial.build.id, { command: 'restart', expectedVersion: aborted.build.version }, alice);
    assert.notEqual(restarted.build.id, initial.build.id); assert.equal(restarted.build.restartOf, initial.build.id); assert.equal(restarted.build.planVersion, 1); assert.equal(restarted.build.plan.steps[0]!.kind, 'external');
    assert.deepEqual(restarted.buildable, initial.buildable); assert.equal(restarted.targets[0]!.attempt, 0); assert.equal(f.service.detail(initial.build.id, alice).build.status, 'aborted');
  } finally { f.close(); }
});

test('build reads, writes, retry receipts and source export all recheck current authority', () => {
  const f = fixture(); try {
    const initial = f.run(f.service.createPlan(planInput([external()]), alice)), claim = f.claim(initial), report = { leaseToken: claim.leaseToken, reportId: 'progress', type: 'work' as const };
    f.service.report(claim.target.id, report, ci); f.revoked.add('ci');
    assert.throws(() => f.service.report(claim.target.id, report, ci), /Revoked/); assert.throws(() => f.service.detail(initial.build.id, ci), /Revoked/);
    f.hidden.add('bob:D1'); assert.deepEqual(f.service.list(bob), []); assert.throws(() => f.service.detail(initial.build.id, bob), /Hidden/);
    f.denied.add('alice'); assert.throws(() => f.service.command(initial.build.id, { command: 'abort', expectedVersion: 3 }, alice), /Read only/);
  } finally { f.close(); }
});

test('durable plans, leases and immutable results survive reopening without restarting work', () => {
  const directory = mkdtempSync(join(tmpdir(), 'harbormaster-')), path = join(directory, 'builds.sqlite');
  try {
    let f = fixture({ path }); const initial = f.run(f.service.createPlan(planInput([external()]), alice)), claim = f.claim(initial); f.close();
    f = fixture({ path }); try {
      assert.equal(f.service.detail(initial.build.id, alice).targets[0]!.attempt, 1);
      const result = f.service.report(claim.target.id, { leaseToken: claim.leaseToken, reportId: 'after-restart', type: 'pass', log: 'Worker continued.' }, ci);
      assert.equal(result.build.status, 'passed'); assert.equal(result.reports.length, 1); assert.equal(f.service.plans(alice).length, 1);
    } finally { f.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('commit builds pin observed repository and commit identities without pretending local text checks compiled a repository', () => {
  const f = fixture(); try {
    const commit: GitCommitResult = { repositoryId: 'R1', objectFormat: 'sha1', commit: { id: 'a'.repeat(40), treeId: 'b'.repeat(40), parentIds: [], author: { name: 'A', email: 'a@example.test', timestamp: '2026-01-01T00:00:00Z' }, committer: { name: 'A', email: 'a@example.test', timestamp: '2026-01-01T00:00:00Z' }, message: 'Commit', messageTruncated: false } };
    const plan = f.service.createPlan(planInput([external()]), alice), result = f.service.runCommit(commit, { planId: plan.id, planVersion: 1 }, alice), claim = f.claim(result);
    assert.equal(result.build.revisionId, null); assert.equal(result.buildable.commitId, commit.commit.id); assert.equal(result.buildable.treeId, commit.commit.treeId); assert.equal(result.buildable.objectFormat, 'sha1'); assert.equal(claim.source, null);
    assert.equal(f.service.report(claim.target.id, { leaseToken: claim.leaseToken, reportId: 'pass', type: 'pass' }, ci).build.status, 'passed');
    f.hidden.add('bob:R1'); assert.equal(f.service.list(bob).length, 0);
    const checks = f.service.createPlan(planInput(), alice); assert.throws(() => f.service.runCommit(commit, { planId: checks.id, planVersion: 1 }, alice), /external or HTTP/);
  } finally { f.close(); }
});

test('HTTP dispatch requires configured endpoint and worker, transmits metadata only, then awaits authenticated results', async () => {
  const denied = fixture(); try { assert.throws(() => denied.service.createPlan(planInput([http()]), alice), /not been configured/); } finally { denied.close(); }
  const missing = fixture({ http: true }); try {
    const result = missing.run(missing.service.createPlan(planInput([http()]), alice));
    await assert.rejects(missing.service.dispatchHttp(result.build.id, alice), /worker identity/);
  } finally { missing.close(); }
  const f = fixture({ http: true, httpActor: true }); try {
    const result = f.run(f.service.createPlan(planInput([http(), local('after', ['dispatch'])]), alice)); let payload: Record<string, unknown> | undefined, calls = 0;
    const fetcher: typeof fetch = async (url, init) => { calls++; assert.equal(url, 'https://ci.example.test/jobs'); assert.equal(init?.redirect, 'error'); assert.ok(init?.signal); payload = JSON.parse(String(init?.body)) as Record<string, unknown>; assert.equal(JSON.stringify(payload).includes('const answer'), false); return new Response(null, { status: 202 }); };
    await f.service.dispatchPendingHttp(fetcher); await f.service.dispatchPendingHttp(fetcher);
    assert.equal(calls, 1); const waiting = f.service.detail(result.build.id, alice); assert.equal(waiting.build.status, 'building'); assert.equal(waiting.reports[0]!.actorId, 'ci');
    assert.throws(() => f.service.report(String(payload!.targetId), { leaseToken: payload!.leaseToken, reportId: 'wrong', type: 'pass' }, alice), /another worker/);
    const finished = f.service.report(String(payload!.targetId), { leaseToken: payload!.leaseToken, reportId: 'external-result', type: 'pass' }, ci); assert.equal(finished.build.status, 'passed');
    const actor = JSON.parse(String(f.db.prepare('SELECT actor FROM harbormaster_builds').get()!.actor)) as Record<string, unknown>; assert.deepEqual(Object.keys(actor).sort(), ['displayName', 'principalId', 'workspaceId']);
  } finally { f.close(); }
});

test('HTTP failures are recorded without response bodies; expired dispatches fail closed without duplicate requests', async () => {
  const f = fixture({ http: true, httpActor: true }); try {
    const plan = f.service.createPlan(planInput([http()]), alice), failed = f.run(plan);
    await f.service.dispatchHttp(failed.build.id, alice, async () => new Response('private remote error body', { status: 500 }));
    const detail = f.service.detail(failed.build.id, alice); assert.equal(detail.build.status, 'failed'); assert.equal(JSON.stringify(detail).includes('private remote'), false);
    const crash = f.run(plan), claim = f.claim(crash, 'dispatch'); f.advance(5 * 60_000 + 1); let calls = 0;
    await f.service.dispatchPendingHttp(async () => { calls++; return new Response(null, { status: 202 }); });
    assert.equal(calls, 0); const expired = f.service.detail(crash.build.id, alice); assert.equal(expired.build.status, 'failed'); assert.match(expired.reports[0]!.log, /not sent again/);
    assert.throws(() => f.service.report(claim.target.id, { leaseToken: claim.leaseToken, reportId: 'late', type: 'pass' }, ci), /expired/);
  } finally { f.close(); }
});

test('HTTP workers revalidate creator and worker authority and never follow redirects', async () => {
  const f = fixture({ http: true, httpActor: true }); try {
    const plan = f.service.createPlan(planInput([http()]), alice), result = f.run(plan); let calls = 0;
    f.denied.add('alice'); await f.service.dispatchPendingHttp(async () => { calls++; return new Response(null, { status: 202 }); }); assert.equal(calls, 0);
    f.denied.delete('alice');
    await f.service.dispatchHttp(result.build.id, alice, async (_url, init) => { calls++; assert.equal(init?.redirect, 'error'); throw new TypeError('Redirect with private remote location'); });
    const failed = f.service.detail(result.build.id, alice); assert.equal(failed.build.status, 'failed'); assert.equal(JSON.stringify(failed).includes('private remote location'), false);
    const second = f.run(plan); f.revoked.add('ci'); await assert.rejects(f.service.dispatchHttp(second.build.id, alice, async () => { calls++; return new Response(null, { status: 202 }); }), /Revoked/); assert.equal(calls, 1);
  } finally { f.close(); }
});

test('shutdown stops between HTTP steps and builds while durably recording the in-flight dispatch', async () => {
  const f = fixture({ http: true, httpActor: true }); try {
    const plan = f.service.createPlan(planInput([http('first'), http('second')]), alice), first = f.run(plan), second = f.run(plan); let stopping = false, calls = 0;
    await f.service.dispatchPendingHttp(async () => { calls++; stopping = true; return new Response(null, { status: 202 }); }, () => stopping);
    assert.equal(calls, 1);
    const interrupted = f.service.detail(first.build.id, alice); assert.deepEqual(interrupted.targets.map(target => target.status), ['building', 'pending']); assert.equal(interrupted.reports.length, 1, 'the completed HTTP acknowledgement is retained');
    assert.equal(f.service.detail(second.build.id, alice).targets.every(target => target.attempt === 0), true, 'no later build was claimed during shutdown');
    await f.service.dispatchPendingHttp(async () => { calls++; return new Response(null, { status: 202 }); }, () => stopping); assert.equal(calls, 1);
  } finally { f.close(); }
});

test('external message validation rejects credential URLs, unsafe text and malformed result positions', () => {
  const report = { leaseToken: 'token', reportId: 'report', type: 'work' };
  assert.throws(() => buildReportInput({ ...report, artifacts: [{ key: 'x', name: 'X', uri: 'javascript:alert(1)' }] }), /HTTP/);
  assert.throws(() => buildReportInput({ ...report, artifacts: [{ key: 'x', name: 'X', uri: 'https://user:password@example.test' }] }), /credentials/);
  assert.throws(() => buildReportInput({ ...report, lint: [{ name: 'Lint', code: 'L', severity: 'error', path: 'main.ts', line: -1 }] }), /positive/);
  assert.throws(() => buildReportInput({ ...report, log: '\ud800' }), /log/);
  assert.throws(() => buildReportInput({ ...report, unit: [{ name: 'Unit', result: 'pass', duration: NaN }] }), /duration/);
});
