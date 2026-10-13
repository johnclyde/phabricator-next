import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp } from './app.ts';
import { createAuth } from './auth.ts';
import { Store } from './store.ts';
import type { GitReceiveFacts, GitReceiveReceipt } from '../shared/git-automation.ts';
import type { HeraldRule, HeraldRuleInput, HeraldTranscript } from '../shared/herald.ts';
import type { BuildDetail, BuildPlan, Build } from '../shared/harbormaster.ts';

const members = (...principalIds: string[]) => ({ kind: 'principals' as const, principalIds }), workspace = { kind: 'workspace' as const };
const a = 'a'.repeat(40), b = 'b'.repeat(40), c = 'c'.repeat(40), identity = { name: 'Raw Git author', email: 'untrusted@example.test', timestamp: '2026-10-13T00:00:00.000Z' };
const rule = (patch: Partial<HeraldRuleInput> = {}): HeraldRuleInput => ({ name: 'Hook rule', contentType: 'push-content', ruleType: 'global', objectId: null, enabled: true, match: 'all', repetition: 'every', conditions: [{ field: 'always', operator: 'true', value: null }], actions: [{ type: 'block-push', value: 'Private source blocked.' }], ...patch });
async function start() {
  const store = new Store({ path: ':memory:' }), provision = createAuth({ database: store.database, mode: 'local', basePath: '/', provisioning: true });
  const alice = await provision.createAccount({ username: 'alice', displayName: 'Receiver Alice', password: 'Receiver fixture private password' }), bob = await provision.createAccount({ username: 'bob', displayName: 'Pusher Bob', password: 'Pusher fixture private password' });
  const app = createApp({ store, seed: false, authMode: 'password', automation: { managers: ['alice', 'bob'], gitReceivers: { R1: ['alice'] } } });
  store.createRepository({ name: 'Receive fixture', remoteUrl: 'https://example.invalid/never-fetched.git' });
  const tokens = { alice: app.auth.createToken(alice.id, { name: 'Trusted receiver', scopes: ['read', 'write'] }).token, bob: app.auth.createToken(bob.id, { name: 'Ordinary editor', scopes: ['read', 'write'] }).token, reader: app.auth.createToken(alice.id, { name: 'Read-only receiver', scopes: ['read'] }).token };
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  async function request<T = { error: string; code?: string }>(path: string, method = 'GET', body?: unknown, actor: keyof typeof tokens = 'alice', key = randomUUID()) {
    const response = await fetch(origin + path, { method, signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${tokens[actor]}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Idempotency-Key': key }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, body: await response.json() as T };
  }
  function policy(changes: Record<string, unknown>) { const current = app.policies.policy('R1', alice.id); return app.policies.setPolicy('R1', { expectedVersion: current.version, spaceId: current.spaceId, ...current.rules, ...changes }, alice.id); }
  const facts = (changes: Partial<GitReceiveFacts> = {}): GitReceiveFacts => ({ repositoryId: 'R1', objectFormat: 'sha1', phase: 'pre', requestId: randomUUID(), pusherId: bob.id, inspectionComplete: true, updates: [{ refName: 'refs/heads/main', oldId: a, newId: b, oldCommitId: a, newCommitId: b, forced: false, commits: [{ inspectionComplete: true, commit: { id: b, treeId: c, parentIds: [a], author: identity, committer: identity, message: 'PRIVATE exact commit message', messageTruncated: false }, files: [{ path: 'source.txt', content: '+PRIVATE exact source', added: 'PRIVATE exact source', removed: '' }] }] }], ...changes });
  return { ...app, alice, bob, request, facts, policy, close: async () => { await app.close(); store.close(); } };
}

test('receive API only trusts configured receivers and requires both receiver and pusher current repository/Space access', async () => {
  const app = await start(); try {
    const facts = app.facts();
    assert.equal((await app.request('/api/herald/receive', 'POST', facts, 'bob')).status, 403, 'ordinary repository editor cannot forge inspection facts');
    assert.equal((await app.request('/api/herald/receive', 'POST', facts, 'reader')).status, 403);
    assert.equal((await app.request('/api/herald/receive', 'POST', { ...facts, repositoryId: 'R2' })).status, 403);
    assert.equal((await app.request('/api/herald/receive', 'POST', { ...facts, pusherId: 'unknown-principal' })).status, 403);
    app.policy({ edit: members(app.alice.id) }); assert.equal((await app.request('/api/herald/receive', 'POST', facts)).status, 403);
    app.policy({ edit: workspace }); const space = app.policies.createSpace({ name: 'Restricted source Space', view: members(app.alice.id), edit: members(app.alice.id) }, app.alice.id); app.policy({ spaceId: space.id });
    assert.equal((await app.request('/api/herald/receive', 'POST', facts)).status, 404, 'pusher cannot bypass repository Space');
    app.policy({ spaceId: 'S1' }); app.auth.setAccountDisabled(app.bob.id, true); assert.equal((await app.request('/api/herald/receive', 'POST', facts)).status, 403);
    assert.equal(app.store.database.prepare('SELECT count(*) AS n FROM git_receive_records').get()!.n, 0); assert.equal(app.store.database.prepare('SELECT count(*) AS n FROM herald_transcripts').get()!.n, 0);
  } finally { await app.close(); }
});

test('receive receipts, stored transcripts, test console and idempotent replay inherit current repository/Space policy', async () => {
  const app = await start(); try {
    const created = await app.request('/api/herald/rules', 'POST', rule()); assert.equal(created.status, 201);
    const facts = app.facts(), key = randomUUID(), first = await app.request<{ receive: GitReceiveReceipt }>('/api/herald/receive', 'POST', facts, 'alice', key); assert.equal(first.status, 200, JSON.stringify(first.body)); assert.equal(first.body.receive.allowed, false);
    const id = first.body.receive.id, transcriptId = first.body.receive.transcriptIds[1];
    const visible = await app.request<{ transcript: HeraldTranscript }>(`/api/herald/transcripts/${transcriptId}`, 'GET', undefined, 'bob'); assert.equal(visible.status, 200); assert.equal(visible.body.transcript.snapshot.body, 'PRIVATE exact commit message');
    const dryKey = randomUUID(), dryInput = { transcriptId }, dry = await app.request<{ transcript: HeraldTranscript }>('/api/herald/test', 'POST', dryInput, 'bob', dryKey); assert.equal(dry.status, 200, JSON.stringify(dry.body)); assert.equal(dry.body.transcript.dryRun, true);
    const policy = app.policy({ view: members(app.alice.id), edit: members(app.alice.id), interact: members(app.alice.id) });
    for (const path of [`/api/herald/transcripts/${transcriptId}`, `/api/herald/receives/${id}`]) { const response = await app.request(path, 'GET', undefined, 'bob'); assert.equal(response.status, 404); assert.equal(JSON.stringify(response.body).includes('PRIVATE'), false); }
    assert.deepEqual((await app.request<{ transcripts: unknown[] }>('/api/herald/transcripts', 'GET', undefined, 'bob')).body.transcripts, []); assert.deepEqual((await app.request<{ receives: unknown[] }>('/api/herald/receives', 'GET', undefined, 'bob')).body.receives, []);
    assert.equal((await app.request('/api/herald/test', 'POST', dryInput, 'bob', dryKey)).status, 404, 'saved dry-run replay cannot reveal revoked source');
    assert.equal((await app.request('/api/herald/receive', 'POST', facts, 'alice', key)).status, 404, 'receive retry revalidates revoked pusher access');
    app.policy({ view: workspace, edit: workspace, interact: workspace, spaceId: policy.spaceId });
    assert.equal((await app.request('/api/herald/receive', 'POST', facts, 'alice', key)).status, 200); assert.equal(app.store.database.prepare('SELECT count(*) AS n FROM git_receive_records').get()!.n, 1);
    const space = app.policies.createSpace({ name: 'Private receiver Space', view: members(app.alice.id), edit: members(app.alice.id) }, app.alice.id); app.policy({ spaceId: space.id });
    assert.equal((await app.request(`/api/herald/transcripts/${transcriptId}`, 'GET', undefined, 'bob')).status, 404); assert.equal((await app.request(`/api/herald/receives/${id}`, 'GET', undefined, 'bob')).status, 404);
  } finally { await app.close(); }
});

test('post-receive triggers commit build plans on exact trusted commits once and exposes repository-bound build evidence', async () => {
  const app = await start(); try {
    const plan = await app.request<{ plan: BuildPlan }>('/api/harbormaster/plans', 'POST', { name: 'Commit checks', description: '', enabled: true, steps: [{ key: 'worker', name: 'Inspect exact commit', kind: 'external', worker: 'trusted-worker', dependsOn: [] }] }); assert.equal(plan.status, 201);
    assert.equal((await app.request('/api/herald/rules', 'POST', rule({ contentType: 'commit', actions: [{ type: 'run-build-plans', targets: [plan.body.plan.id] }] }))).status, 201);
    const facts = app.facts({ phase: 'post' }), first = await app.request<{ receive: GitReceiveReceipt }>('/api/herald/receive', 'POST', facts); assert.equal(first.status, 200, JSON.stringify(first.body)); assert.equal(first.body.receive.commitIds.length, 1);
    const transcript = await app.request<{ transcript: HeraldTranscript }>(`/api/herald/transcripts/${first.body.receive.transcriptIds[0]}`); assert.equal(transcript.status, 200); assert.equal(transcript.body.transcript.actions[0].status, 'applied', JSON.stringify(transcript.body));
    const builds = await app.request<{ builds: Build[] }>('/api/harbormaster/builds?objectId=R1'); assert.equal(builds.status, 200); assert.equal(builds.body.builds.length, 1);
    const detail = await app.request<BuildDetail>(`/api/harbormaster/builds/${builds.body.builds[0].id}`); assert.equal(detail.body.buildable.repositoryId, 'R1'); assert.equal(detail.body.buildable.commitId, b);
    const again = await app.request<{ receive: GitReceiveReceipt }>('/api/herald/receive', 'POST', { ...facts, requestId: randomUUID() }); assert.equal(again.status, 200); assert.deepEqual(again.body.receive.commitIds, first.body.receive.commitIds); assert.deepEqual(again.body.receive.transcriptIds, []); assert.equal((await app.request<{ builds: Build[] }>('/api/harbormaster/builds?objectId=R1')).body.builds.length, 1);
    const dry = await app.request<{ transcript: HeraldTranscript }>('/api/herald/test', 'POST', { objectId: first.body.receive.commitIds[0] }); assert.equal(dry.status, 200); assert.equal(dry.body.transcript.actions[0].status, 'dry-run'); assert.equal((await app.request<{ builds: Build[] }>('/api/harbormaster/builds?objectId=R1')).body.builds.length, 1);
    app.policy({ view: members(app.alice.id) }); assert.equal((await app.request(`/api/harbormaster/builds/${builds.body.builds[0].id}`, 'GET', undefined, 'bob')).status, 404);
  } finally { await app.close(); }
});

test('saved commit and push transcript projections retain exact historical rule dependencies', async () => {
  const app = await start(); try {
    const project = app.store.createProject({ name: 'PRIVATE rule scope' }, { principalId: app.alice.id, displayName: 'Alice', credentialId: null, requestId: randomUUID() });
    const policy = app.policies.policy(project.id, app.alice.id); app.policies.setPolicy(project.id, { expectedVersion: policy.version, spaceId: policy.spaceId, ...policy.rules, view: members(app.alice.id) }, app.alice.id);
    const input = rule({ name: 'PRIVATE hidden predicate', conditions: [{ field: 'projectIds', operator: 'none', value: [project.id] }] }), created = await app.request<{ rule: HeraldRule }>('/api/herald/rules', 'POST', input); assert.equal(created.status, 201);
    const facts = app.facts(), key = randomUUID(), received = await app.request<{ receive: GitReceiveReceipt }>('/api/herald/receive', 'POST', facts, 'alice', key); assert.equal(received.status, 200); const transcriptId = received.body.receive.transcriptIds[1];
    assert.equal(received.body.receive.allowed, false); assert.equal(received.body.receive.reasons.includes('Private source blocked.'), false, 'privileged receiver response is safe to print to the less privileged pusher');
    const receipt = await app.request<{ receive: GitReceiveReceipt }>(`/api/herald/receives/${received.body.receive.id}`, 'GET', undefined, 'bob'); assert.equal(receipt.status, 200); assert.equal(receipt.body.receive.reasons.includes('Private source blocked.'), false); assert.match(receipt.body.receive.reasons[0], /rejected/);
    const owner = await app.request<{ receive: GitReceiveReceipt }>(`/api/herald/receives/${received.body.receive.id}`); assert.ok(owner.body.receive.reasons.includes('Private source blocked.'));
    assert.equal((await app.request(`/api/herald/rules/${created.body.rule.id}`, 'PUT', { ...rule({ name: 'Now public' }), expectedVersion: 1 })).status, 200);
    const transcript = await app.request<{ transcript: HeraldTranscript }>(`/api/herald/transcripts/${transcriptId}`, 'GET', undefined, 'bob'); assert.equal(transcript.status, 200); assert.deepEqual(transcript.body.transcript.rules, []); assert.deepEqual(transcript.body.transcript.actions, []); assert.equal(JSON.stringify(transcript.body.transcript.rules).includes('PRIVATE'), false);
    const replay = await app.request<{ receive: GitReceiveReceipt }>('/api/herald/receive', 'POST', facts, 'alice', key); assert.equal(replay.status, 200); assert.equal(replay.body.receive.reasons.includes('Private source blocked.'), false, 'historical hidden predicate stays hidden on hook response replay');
    const dry = await app.request<{ transcript: HeraldTranscript }>('/api/herald/test', 'POST', { transcriptId }, 'bob'); assert.equal(dry.status, 200); assert.equal(dry.body.transcript.rules[0].name, 'Now public', 'a new dry run uses current rules over the saved exact event facts');
  } finally { await app.close(); }
});

test('push rule authors who lose repository edit or account access cannot deny pushes through forbidden actions', async () => {
  const app = await start(); try {
    assert.equal((await app.request('/api/herald/rules', 'POST', rule(), 'bob')).status, 201);
    const receive = () => app.request<{ receive: GitReceiveReceipt }>('/api/herald/receive', 'POST', app.facts({ pusherId: app.alice.id }));
    assert.equal((await receive()).body.receive.allowed, false);
    app.policy({ edit: members(app.alice.id) });
    const lostEdit = await receive(); assert.equal(lostEdit.status, 200); assert.equal(lostEdit.body.receive.allowed, true, 'a global manager without repository Edit cannot block indirectly via a forbidden action');
    const skipped = await app.request<{ transcript: HeraldTranscript }>(`/api/herald/transcripts/${lostEdit.body.receive.transcriptIds[1]}`); assert.equal(skipped.body.transcript.rules[0].status, 'forbidden'); assert.deepEqual(skipped.body.transcript.actions, []);
    app.policy({ edit: workspace }); app.auth.setAccountDisabled(app.bob.id, true);
    const disabled = await receive(); assert.equal(disabled.status, 200); assert.equal(disabled.body.receive.allowed, true);
  } finally { await app.close(); }
});
