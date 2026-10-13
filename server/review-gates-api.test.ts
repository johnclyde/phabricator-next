import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp } from './app.ts';
import { createAuth } from './auth.ts';
import { Store } from './store.ts';
import { createGitFixture } from '../tests/git-fixture.ts';
import { createGitObserver } from './git.ts';
import { inspectReceive } from './git-receive-inspection.ts';
import type { GitReceiveFacts, GitReceiveReceipt } from '../shared/git-automation.ts';
import type { HeraldRule, HeraldRuleInput, HeraldTranscript } from '../shared/herald.ts';
import type { BuildDetail, BuildPlan } from '../shared/harbormaster.ts';
import type { AuditDetail, AuditList } from '../shared/audit.ts';
import type { RevisionLandingDetail, RevisionLandingSnapshot } from '../shared/revision-landing.ts';

const members = (...principalIds: string[]) => ({ kind: 'principals' as const, principalIds });
const workspace = { kind: 'workspace' as const };
const baseRule: HeraldRuleInput = { name: 'Require accepted exact revision', contentType: 'push-content', ruleType: 'global', objectId: null, enabled: true, match: 'all', repetition: 'every', conditions: [{ field: 'acceptedRevision', operator: '!exists', value: null }], actions: [{ type: 'block-push', value: 'Accept this exact source before pushing.' }] };
async function fixture(summary = '', kind: 'code' | 'paper' | 'document' = 'code') {
  const git = await createGitFixture(), store = new Store({ path: ':memory:' }), provision = createAuth({ database: store.database, mode: 'local', basePath: '/', provisioning: true });
  const alice = await provision.createAccount({ username: 'alice', displayName: 'Alice', password: 'Audit API fixture private password' }), bob = await provision.createAccount({ username: 'bob', displayName: 'Bob', password: 'Other audit fixture private password' });
  const app = createApp({ store, seed: false, authMode: 'password', gitRepositories: { R1: git.barePath }, landingBindings: [{ key: 'local', repositoryId: 'R1', repositoryPath: git.barePath, branches: ['refs/heads/main'] }], automation: { managers: ['alice', 'bob'], gitReceivers: { R1: ['alice'] } } });
  await app.automation.close();
  store.createRepository({ name: 'Reviewed source', remoteUrl: 'https://example.invalid/review.git' });
  const actor = { principalId: alice.id, displayName: alice.displayName, credentialId: null, requestId: 'review-source' }, buildActor = { principalId: alice.id, displayName: alice.displayName, workspaceId: app.auth.workspaceId };
  const observer = createGitObserver({ R1: git.barePath }), imported = await observer.importSnapshot('R1', git.importNextCommit);
  const revision = store.createRevisionFromGit('R1', { commitId: git.importNextCommit, kind, title: 'Exact reviewed source', summary, testPlan: 'Inspect immutable source.' }, imported, actor), id = revision.revision.id;
  await git.git(['update-ref', 'refs/heads/main', git.importCommit]);
  const inspected = await inspectReceive(git.barePath, `${git.importCommit} ${git.importNextCommit} refs/heads/main\n`, 'pre');
  const facts = (phase: 'pre' | 'post' = 'pre'): GitReceiveFacts => ({ repositoryId: 'R1', objectFormat: inspected.objectFormat, inspectionComplete: true, pusherId: alice.id, phase, requestId: randomUUID(), updates: inspected.updates.map(({ commitIds, ...update }) => ({ ...update, commits: commitIds.map(id => { const { branches: _branches, ...commit } = inspected.commits.find(item => item.commit.id === id)!; return commit; }) })) });
  const accept = () => { const detail = store.detail(id); store.saveReview(id, detail.revision.currentVersion, { provider: 'local', model: 'fixture-check', summary: 'Verified source', findings: [] }, actor); const s = store.revisionLifecycle.snapshot(id, alice.id); store.revisionLifecycle.mutate(id, { action: 'accept_reviewed', message: '', expectedLifecycleVersion: s.lifecycle.version, expectedAuthorVersion: s.authorship.version, expectedReviewerVersion: s.reviewers.version, expectedVersion: s.head.number, expectedVersionId: s.head.versionId, expectedContentHash: s.head.contentHash, expectedAccessEpoch: app.policies.epoch(), expectedConfigId: s.configId, expectedEvidenceSha256: s.evidence.sha256 }, actor); };
  const tokens = { alice: app.auth.createToken(alice.id, { name: 'Receiver', scopes: ['read', 'write'] }).token, bob: app.auth.createToken(bob.id, { name: 'Reviewer', scopes: ['read', 'write'] }).token, reader: app.auth.createToken(alice.id, { name: 'Reader', scopes: ['read'] }).token };
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  async function request<T = { error: string }>(path: string, method = 'GET', body?: unknown, who: keyof typeof tokens = 'alice', key = randomUUID()) { const response = await fetch(origin + path, { method, signal: AbortSignal.timeout(30_000), headers: { Authorization: `Bearer ${tokens[who]}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Idempotency-Key': key }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, body: await response.json() as T }; }
  const receive = (value = facts()) => request<{ receive: GitReceiveReceipt }>('/api/herald/receive', 'POST', value);
  const policy = (subject: string, changes: Record<string, unknown>) => { const p = app.policies.policy(subject, alice.id); app.policies.setPolicy(subject, { expectedVersion: p.version, spaceId: p.spaceId, ...p.rules, ...changes }, alice.id); };
  const planInput = { name: 'Required exact source checks', description: '', enabled: true, steps: [{ key: 'worker', name: 'Verify exact source', kind: 'external', worker: 'fixture', dependsOn: [] }] };
  const build = (plan: BuildPlan) => { const head = store.detail(id).versions.at(-1)!; return app.automation.harbormaster.run(id, { planId: plan.id, planVersion: plan.version, versionId: head.id, contentHash: head.contentHash }, buildActor); };
  const pass = (detail: BuildDetail) => { const target = detail.targets[0]!, claim = app.automation.harbormaster.claim({ targetId: target.id, expectedVersion: target.version, worker: 'fixture' }, buildActor); return app.automation.harbormaster.report(target.id, { leaseToken: claim.leaseToken, reportId: randomUUID(), type: 'pass' }, buildActor); };
  return { ...app, git, actor, buildActor, alice, bob, id, facts, receive, accept, request, policy, planInput, build, pass, close: async () => { await app.close(); store.close(); await git.close(); } };
}

test('real inspected pushes require current acceptance and required exact-source current-plan builds', async () => {
  const f = await fixture(); try {
    assert.equal((await f.request('/api/herald/rules', 'POST', baseRule)).status, 201);
    let received = await f.receive(); assert.equal(received.status, 200, JSON.stringify(received.body)); assert.equal(received.body.receive.allowed, false);
    f.accept(); received = await f.receive(); assert.equal(received.body.receive.allowed, true);
    const plan = f.automation.harbormaster.createPlan(f.planInput, f.buildActor);
    assert.equal((await f.request('/api/herald/rules', 'POST', { ...baseRule, name: 'Require build plans', conditions: [{ field: 'always', operator: 'true', value: null }], actions: [{ type: 'require-build-plans', targets: [plan.id] }] })).status, 201);
    received = await f.receive(); assert.equal(received.body.receive.allowed, false); assert.match(received.body.receive.reasons.join(' '), /missing/);
    const pending = f.build(plan); assert.equal((await f.receive()).body.receive.allowed, false); f.pass(pending);
    const exact = f.facts(), passed = await f.receive(exact); assert.equal(passed.body.receive.allowed, true);
    const transcript = await f.request<{ transcript: HeraldTranscript }>(`/api/herald/transcripts/${passed.body.receive.transcriptIds.at(-1)}`);
    assert.equal(transcript.body.transcript.snapshot.git?.review?.revision?.revisionId, f.id); assert.equal(transcript.body.transcript.snapshot.git?.review?.revision?.accepted, true);
    f.automation.harbormaster.updatePlan(plan.id, { ...f.planInput, expectedVersion: 1, description: 'New verification version' }, f.buildActor);
    received = await f.receive(); assert.equal(received.body.receive.allowed, false); assert.match(received.body.receive.reasons.join(' '), /stale/);
    assert.equal((await f.receive(exact)).body.receive.allowed, true, 'old receipt preserves historical decision; a new push receives a new decision');
    const head = f.store.detail(f.id).versions.at(-1)!;
    f.store.createVersion(f.id, { expectedVersion: head.number, expectedVersionId: head.id, expectedContentHash: head.contentHash, files: head.files.map((file, index) => ({ ...file, content: file.content + (index === 0 ? '\nUnreviewed source' : '') })), message: 'Source changed.' }, f.actor);
    assert.equal((await f.receive()).body.receive.allowed, false, 'older accepted tree cannot borrow current revision acceptance');
  } finally { await f.close(); }
});

test('private linked revision evidence and results stay hidden in receive, transcript, dry-run and replays', async () => {
  const f = await fixture(); try {
    f.accept(); await f.request('/api/herald/rules', 'POST', baseRule);
    const facts = f.facts(), result = await f.receive(facts), transcriptId = result.body.receive.transcriptIds.at(-1)!;
    f.policy(f.id, { view: members(f.alice.id), edit: members(f.alice.id), interact: members(f.alice.id) });
    const shown = await f.request<{ transcript: HeraldTranscript }>(`/api/herald/transcripts/${transcriptId}`, 'GET', undefined, 'bob');
    assert.equal(shown.status, 200); assert.equal(shown.body.transcript.snapshot.git?.review, undefined); assert.deepEqual(shown.body.transcript.rules, []);
    const dry = await f.request<{ transcript: HeraldTranscript }>('/api/herald/test', 'POST', { transcriptId }, 'bob'); assert.equal(dry.status, 200); assert.equal(dry.body.transcript.snapshot.git?.review, undefined);
    assert.equal((await f.request('/api/herald/rules', 'POST', { ...baseRule, name: 'Reviewer-owned gate' }, 'bob')).status, 201);
    const blocked = await f.receive(); assert.equal(blocked.body.receive.allowed, false, 'active repository rule cannot silently ignore inaccessible evidence');
    f.policy(f.id, { view: workspace, edit: workspace, interact: workspace });
    assert.equal((await f.request<{ transcript: HeraldTranscript }>(`/api/herald/transcripts/${transcriptId}`, 'GET', undefined, 'bob')).body.transcript.snapshot.git?.review?.revision?.revisionId, f.id);
  } finally { await f.close(); }
});

test('Audit receives immutable commits once, requests auditors from Herald and preserves manual command receipts under policy changes', async () => {
  const f = await fixture(); try {
    await f.request('/api/herald/rules', 'POST', { ...baseRule, contentType: 'commit', conditions: [{ field: 'always', operator: 'true', value: null }], actions: [{ type: 'add-auditors', targets: [f.bob.id] }, { type: 'audit-self' }] });
    const first = await f.receive(f.facts('post')); assert.equal(first.status, 200, JSON.stringify(first.body)); const id = first.body.receive.commitIds[0]!, path = `/api/audit/commits/${id}`;
    let detail = (await f.request<AuditDetail>(path)).body; assert.equal(detail.audit.auditors.length, 2); assert.equal(detail.audit.status, 'needs-audit');
    const files = await f.request<{ files: unknown[] }>(`${path}/files`); assert.equal(files.status, 200); assert.ok(files.body.files.length);
    const unchanged = await f.receive(f.facts('post')); assert.equal(unchanged.status, 200); assert.equal((await f.request<AuditDetail>(path)).body.audit.version, detail.audit.version);
    const key = randomUUID(), input = { expectedVersion: detail.audit.version, command: 'concern', comment: 'Inspect the change in assumptions.' };
    const concern = await f.request<AuditDetail>(`${path}/command`, 'POST', input, 'bob', key); assert.equal(concern.status, 200, JSON.stringify(concern.body)); assert.equal(concern.body.audit.status, 'concern-raised');
    assert.deepEqual(await f.request(`${path}/command`, 'POST', input, 'bob', key), concern);
    assert.equal((await f.request(`${path}/command`, 'POST', input, 'bob')).status, 409);
    detail = (await f.request<AuditDetail>(`${path}/command`, 'POST', { expectedVersion: concern.body.audit.version, command: 'accept', comment: 'Resolved.' }, 'bob')).body; assert.equal(detail.audit.status, 'partially-audited');
    assert.equal((await f.request(`${path}/command`, 'POST', { expectedVersion: detail.audit.version, command: 'accept' }, 'reader')).status, 403);
    detail = (await f.request<AuditDetail>(`${path}/command`, 'POST', { expectedVersion: detail.audit.version, command: 'accept' })).body; assert.equal(detail.audit.status, 'audited'); assert.ok(detail.history.events.some(event => event.action === 'concern'));
    f.policy('R1', { edit: members(f.alice.id), interact: workspace });
    const reviewer = await f.request<AuditDetail>(path, 'GET', undefined, 'bob'); assert.equal(reviewer.body.canEdit, false); assert.equal(reviewer.body.canInteract, true);
    const comment = await f.request<AuditDetail>(`${path}/command`, 'POST', { expectedVersion: detail.audit.version, command: 'comment', comment: 'Review without push permission.' }, 'bob'); assert.equal(comment.status, 200);
    assert.equal((await f.request(`${path}/request`, 'POST', { expectedVersion: comment.body.audit.version, auditorIds: [f.alice.id] }, 'bob')).status, 403);
    f.policy('R1', { view: members(f.alice.id), edit: members(f.alice.id), interact: members(f.alice.id) });
    assert.equal((await f.request(path, 'GET', undefined, 'bob')).status, 404); assert.equal((await f.request(`${path}/files`, 'GET', undefined, 'bob')).status, 404);
    assert.equal((await f.request(`${path}/command`, 'POST', input, 'bob', key)).status, 404); assert.deepEqual((await f.request<AuditList>('/api/audit/commits', 'GET', undefined, 'bob')).body.audits, []);
  } finally { await f.close(); }
});

test('native landing enforces builds at execution and observes the resulting commit for Audit', async () => {
  const f = await fixture(); try {
    f.accept(); const plan = f.automation.harbormaster.createPlan(f.planInput, f.buildActor);
    await f.request<HeraldRule>('/api/herald/rules', 'POST', { ...baseRule, conditions: [{ field: 'always', operator: 'true', value: null }], actions: [{ type: 'require-build-plans', targets: [plan.id] }] });
    const path = `/api/revisions/${f.id}/landings`;
    const prepare = async () => { const state = (await f.request<RevisionLandingSnapshot>(path)).body; const result = await f.request<RevisionLandingDetail>(path, 'POST', { ...state.pins, binding: 'local', branch: 'refs/heads/main', baseCommitId: f.git.importCommit, expectedTargetCommitId: f.git.importCommit }); assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body; };
    const prepared = await prepare(), blocked = await f.request<RevisionLandingDetail>(`/api/landings/${prepared.operation.id}/commands`, 'POST', { command: 'land', expectedVersion: 1 }); assert.equal(blocked.status, 200); assert.equal(blocked.body.operation.state, 'conflict'); assert.equal((await f.git.git(['rev-parse', 'refs/heads/main'])).trim(), f.git.importCommit);
    const ready = await prepare(); f.pass(f.build(plan));
    const landed = await f.request<RevisionLandingDetail>(`/api/landings/${ready.operation.id}/commands`, 'POST', { command: 'land', expectedVersion: 1 }); assert.equal(landed.status, 200, JSON.stringify(landed.body)); assert.equal(landed.body.operation.state, 'landed');
    const audits = (await f.request<AuditList>('/api/audit/commits')).body.audits; assert.equal(audits.length, 1); assert.equal(audits[0]!.source.commit.id, landed.body.operation.prepared.commitId);
  } finally { await f.close(); }
});

test('an unsupported unrelated revision cannot brick Git receive or become a verified review association', async () => {
  const f = await fixture(); try {
    f.accept();
    const imported = await createGitObserver({ R1: f.git.barePath }).importSnapshot('R1', f.git.importCommit);
    const unrelated = f.store.createRevisionFromGit('R1', { commitId: f.git.importCommit, kind: 'code', title: 'Unrelated platform-specific source', testPlan: 'Review source.' }, imported, f.actor);
    const head = unrelated.versions.at(-1)!, unsupportedFiles = [{ path: 'CON.txt', content: 'Valid source text with a nonportable Git working-copy filename.\n' }];
    f.store.createVersion(unrelated.revision.id, { expectedVersion: head.number, expectedVersionId: head.id, expectedContentHash: head.contentHash, files: unsupportedFiles, message: 'Platform-specific name.' }, f.actor);
    const ordinary = await f.receive(); assert.equal(ordinary.status, 200, JSON.stringify(ordinary.body)); assert.equal(ordinary.body.receive.allowed, true);
    const ordinaryTranscript = (await f.request<{ transcript: HeraldTranscript }>(`/api/herald/transcripts/${ordinary.body.receive.transcriptIds.at(-1)}`)).body.transcript;
    assert.equal(ordinaryTranscript.snapshot.git?.review?.revision?.revisionId, f.id, 'the unrelated unsupported candidate does not hide a valid exact source');
    const blob = (await f.git.git(['hash-object', '-w', '--stdin'], unsupportedFiles[0]!.content)).trim();
    const tree = (await f.git.git(['mktree', '-z'], `100644 blob ${blob}\tCON.txt\0`)).trim();
    const commit = (await f.git.git(['commit-tree', tree, '-p', f.git.importCommit], `Platform-specific source\n\nDifferential Revision: ${unrelated.revision.id}\n`)).trim();
    const inspected = await inspectReceive(f.git.barePath, `${f.git.importCommit} ${commit} refs/heads/main\n`, 'pre');
    const facts: GitReceiveFacts = { repositoryId: 'R1', objectFormat: inspected.objectFormat, inspectionComplete: true, pusherId: f.alice.id, phase: 'pre', requestId: randomUUID(), updates: inspected.updates.map(({ commitIds, ...update }) => ({ ...update, commits: commitIds.map(id => { const { branches: _branches, ...item } = inspected.commits.find(item => item.commit.id === id)!; return item; }) })) };
    const unguarded = await f.receive(facts); assert.equal(unguarded.status, 200, JSON.stringify(unguarded.body)); assert.equal(unguarded.body.receive.allowed, true, 'absence of an acceptance policy permits ordinary inspected source');
    const transcript = (await f.request<{ transcript: HeraldTranscript }>(`/api/herald/transcripts/${unguarded.body.receive.transcriptIds.at(-1)}`)).body.transcript;
    assert.equal(transcript.snapshot.git?.review?.association, 'mismatch'); assert.equal(transcript.snapshot.git?.review?.revision, null);
    assert.equal((await f.request('/api/herald/rules', 'POST', baseRule)).status, 201);
    assert.equal((await f.receive()).body.receive.allowed, true);
    const guarded = await f.receive({ ...facts, requestId: randomUUID() }); assert.equal(guarded.status, 200); assert.equal(guarded.body.receive.allowed, false, 'a trailer cannot grant authority to an unsupported revision patch');
  } finally { await f.close(); }
});

test('actual collected commits cannot use a forged review trailer to borrow another tree or revision acceptance', async () => {
  const f = await fixture(); try {
    f.accept(); assert.equal((await f.request('/api/herald/rules', 'POST', baseRule)).status, 201);
    for (const [treeCommit, revisionId] of [[f.git.importCommit, f.id], [f.git.importNextCommit, 'D999']] as const) {
      const tree = (await f.git.git(['rev-parse', `${treeCommit}^{tree}`])).trim();
      const commit = (await f.git.git(['commit-tree', tree, '-p', f.git.importCommit], `Misleading review reference\n\nDifferential Revision: ${revisionId}\n`)).trim();
      const inspected = await inspectReceive(f.git.barePath, `${f.git.importCommit} ${commit} refs/heads/main\n`, 'pre');
      const facts: GitReceiveFacts = { repositoryId: 'R1', objectFormat: inspected.objectFormat, inspectionComplete: true, pusherId: f.alice.id, phase: 'pre', requestId: randomUUID(), updates: inspected.updates.map(({ commitIds, ...update }) => ({ ...update, commits: commitIds.map(id => { const { branches: _branches, ...item } = inspected.commits.find(item => item.commit.id === id)!; return item; }) })) };
      const blocked = await f.receive(facts); assert.equal(blocked.status, 200, JSON.stringify(blocked.body)); assert.equal(blocked.body.receive.allowed, false);
      const transcript = (await f.request<{ transcript: HeraldTranscript }>(`/api/herald/transcripts/${blocked.body.receive.transcriptIds.at(-1)}`)).body.transcript;
      assert.equal(transcript.snapshot.git?.review?.association, 'mismatch'); assert.equal(transcript.snapshot.git?.review?.revision, null);
    }
  } finally { await f.close(); }
});

for (const kind of ['code', 'paper', 'document'] as const) test(`native ${kind} landing ignores quoted body references and enforces its terminal revision trailer`, async () => {
  // A lone CR is literal corpus text, permitted by the metadata validator;
  // JavaScript multiline anchors previously misread it as a trailer boundary.
  const f = await fixture('This change documents an older commit reference.\rDifferential Revision: D99\n\nThe reference above is quoted background.', kind); try {
    f.accept();
    assert.equal((await f.request('/api/herald/rules', 'POST', baseRule)).status, 201);
    const plan = f.automation.harbormaster.createPlan(f.planInput, f.buildActor); f.pass(f.build(plan));
    assert.equal((await f.request('/api/herald/rules', 'POST', { ...baseRule, name: 'Require exact reviewed build', conditions: [{ field: 'always', operator: 'true', value: null }], actions: [{ type: 'require-build-plans', targets: [plan.id] }] })).status, 201);
    const path = `/api/revisions/${f.id}/landings`, state = (await f.request<RevisionLandingSnapshot>(path)).body;
    const prepared = await f.request<RevisionLandingDetail>(path, 'POST', { ...state.pins, binding: 'local', branch: 'refs/heads/main', baseCommitId: f.git.importCommit, expectedTargetCommitId: f.git.importCommit });
    assert.equal(prepared.status, 201, JSON.stringify(prepared.body));
    const landed = await f.request<RevisionLandingDetail>(`/api/landings/${prepared.body.operation.id}/commands`, 'POST', { command: 'land', expectedVersion: 1 });
    assert.equal(landed.status, 200, JSON.stringify(landed.body)); assert.equal(landed.body.operation.state, 'landed');
    const audits = (await f.request<AuditList>('/api/audit/commits')).body.audits; assert.equal(audits.length, 1);
    assert.match(audits[0]!.source.commit.message, /Differential Revision: D99/);
    assert.match(audits[0]!.source.commit.message, new RegExp(`Differential Revision: ${f.id}\\nRevision Version:`));
    const review = f.automation.git.snapshot(audits[0]!.id).git?.review;
    assert.equal(review?.association, 'verified'); assert.equal(review?.revision?.revisionId, f.id); assert.equal(review?.revision?.accepted, true); assert.equal(review?.builds.find(item => item.planId === plan.id)?.status, 'passed');
  } finally { await f.close(); }
});
