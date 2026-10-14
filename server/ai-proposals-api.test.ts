import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp } from './app.ts';
import { createAuth } from './auth.ts';
import { Store } from './store.ts';
import type { ActorAttribution } from '../shared/types.ts';
import { aiProposalHead, type AIProposalDetail, type AIProposalList } from '../shared/ai-proposals.ts';
import type { AIProposalGenerator } from './ai-proposal-provider.ts';

async function fixture(basePath = '/', override?: AIProposalGenerator) {
  const store = new Store({ path: ':memory:' }), provision = createAuth({ database: store.database, mode: 'local', basePath, provisioning: true });
  const alice = await provision.createAccount({ username: 'alice', displayName: 'Alice', password: 'Private proposal fixture password' });
  const bob = await provision.createAccount({ username: 'bob', displayName: 'Bob', password: 'Private proposal fixture password' });
  let calls = 0;
  const app = createApp({ store, seed: false, authMode: 'password', basePath, aiConfiguration: () => ({ configured: true, model: 'fixture-only' }), aiProposalProvider: async (...args) => {
    calls++; if (override) return override(...args);
    const [input, source] = args, file = source.files[0]!;
    return { result: { summary: 'Synthetic edit.', limitations: 'No model called.', edits: [{ filePath: file.path, start: file.start, end: file.start + 5, quote: 'rough', replacement: 'clear', explanation: 'Synthetic test edit.' }] }, providerResponseId: `fixture-${calls}`, responseModel: input.model };
  } });
  const tokens = {
    alice: app.auth.createToken(alice.id, { name: 'Author', scopes: ['read', 'write', 'review:hosted'] }),
    bob: app.auth.createToken(bob.id, { name: 'Reviewer', scopes: ['read', 'write', 'review:hosted'] }),
    writer: app.auth.createToken(alice.id, { name: 'No provider scope', scopes: ['read', 'write'] }),
    reader: app.auth.createToken(alice.id, { name: 'Read only', scopes: ['read'] }),
  };
  const actor: ActorAttribution = { principalId: alice.id, displayName: 'Alice', credentialId: tokens.alice.record.id, requestId: 'fixture' };
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const request = async <T = { error: string; code?: string }>(path: string, method = 'GET', value?: unknown, who: keyof typeof tokens = 'alice', key?: string) => {
    const response = await fetch(`${origin}${basePath.replace(/\/$/, '')}${path}`, { method, headers: { Authorization: `Bearer ${tokens[who].token}`, ...(value === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
    return { status: response.status, body: await response.json() as T, headers: response.headers };
  };
  const policy = (id: string, rules: Record<string, unknown>) => { const p = app.policies.policy(id, alice.id); app.policies.setPolicy(id, { expectedVersion: p.version, spaceId: p.spaceId, ...p.rules, ...rules }, alice.id); };
  const create = () => { const detail = store.createRevision({ kind: 'paper', title: 'Proposal test', testPlan: 'Inspect exact changes.', files: [{ path: 'paper.tex', content: 'rough original text.\n' }] }, actor); policy(detail.revision.id, { view: { kind: 'workspace' }, interact: { kind: 'workspace' }, edit: { kind: 'principals', principalIds: [alice.id] } }); return detail; };
  const input = (id: string) => { const d = store.detail(id); return { provider: 'openai', model: 'fixture-only', instruction: 'Private instruction, never public.', expectedHead: aiProposalHead(d.versions.find(v => v.number === d.revision.currentVersion)!), expectedAccessEpoch: app.policies.epoch(), scope: null, allowHosted: true }; };
  return { ...app, alice, bob, actor, request, policy, create, input, calls: () => calls, close: async () => { await app.close(); store.close(); } };
}
for (const mount of ['/', '/mounted/']) test(`AI proposal HTTP privacy, explicit provider scope and exact historical retries at ${mount}`, async () => {
  const f = await fixture(mount);
  try {
    const d = f.create(), id = d.revision.id, path = `/api/revisions/${id}/ai-proposals`, input = f.input(id), key = randomUUID();
    assert.equal((await f.request(path, 'POST', input, 'alice')).status, 400);
    assert.equal((await f.request(path, 'POST', input, 'writer', randomUUID())).status, 403);
    assert.equal((await f.request(path, 'POST', { ...input, allowHosted: false }, 'alice', randomUUID())).status, 400);
    assert.equal(f.calls(), 0);
    const generated = await f.request<AIProposalDetail>(path, 'POST', input, 'alice', key);
    assert.equal(generated.status, 200, JSON.stringify(generated.body)); assert.equal(generated.headers.get('cache-control'), 'no-store');
    const proposal = generated.body.proposal; assert.equal(proposal.status, 'ready'); assert.equal(f.calls(), 1);
    assert.equal(f.store.detail(id).revision.currentVersion, 1);
    assert.equal((await f.request<AIProposalList>(path, 'GET', undefined, 'bob')).body.items.length, 0);
    const foreign = await f.request(`${path}/${proposal.id}`, 'GET', undefined, 'bob'), missing = await f.request(`${path}/${randomUUID()}`, 'GET', undefined, 'bob');
    assert.equal(foreign.status, 404); assert.deepEqual(foreign.body, missing.body);
    for (const route of ['/api/state', `/api/revisions/${id}`, `/api/revisions/${id}/export`]) assert.doesNotMatch(JSON.stringify((await f.request(route, 'GET', undefined, 'bob')).body), /Private instruction|Synthetic edit/);
    const apply = { expectedHead: input.expectedHead, expectedAccessEpoch: f.policies.epoch(), expectedProposalSha256: proposal.proposalSha256 }, applyKey = randomUUID();
    assert.equal((await f.request(`${path}/${proposal.id}/apply`, 'POST', apply, 'reader', randomUUID())).status, 403);
    const applied = await f.request<AIProposalDetail>(`${path}/${proposal.id}/apply`, 'POST', apply, 'alice', applyKey);
    assert.equal(applied.status, 200, JSON.stringify(applied.body)); assert.equal(applied.body.proposal.applied?.toVersion, 2);
    const version = f.store.detail(id).versions.find(v => v.number === 2)!; assert.equal(version.files[0]!.content, 'clear original text.\n'); assert.match(version.message, /AI-assisted.*fixture-only/); assert.doesNotMatch(version.message, /Private instruction/);
    f.store.createVersion(id, { files: [{ path: 'paper.tex', content: 'Later source.\n' }], expectedVersion: 2, message: 'Later' }, f.actor);
    assert.equal((await f.request<AIProposalDetail>(path, 'POST', input, 'alice', key)).body.proposal.id, proposal.id);
    assert.equal((await f.request<AIProposalDetail>(`${path}/${proposal.id}/apply`, 'POST', apply, 'alice', applyKey)).body.proposal.applied?.toVersion, 2);
    assert.equal(f.calls(), 1); assert.equal(f.store.detail(id).revision.currentVersion, 3);
    assert.equal((await f.request(path, 'POST', { ...input, instruction: 'Different' }, 'alice', key)).status, 409);
    for (const query of ['?principalId=x', '?limit=1&limit=2', '?limit=0', '?before=']) assert.equal((await f.request(path + query)).status, 400);
  } finally { await f.close(); }
});
test('a reviewer can propose privately but cannot apply without source edit authority', async () => {
  const f = await fixture();
  try {
    const id = f.create().revision.id, path = `/api/revisions/${id}/ai-proposals`, input = f.input(id);
    const p = await f.request<AIProposalDetail>(path, 'POST', input, 'bob', randomUUID());
    assert.equal(p.status, 200); assert.equal(p.body.canApply, false);
    assert.equal((await f.request(`${path}/${p.body.proposal.id}/apply`, 'POST', { expectedHead: input.expectedHead, expectedAccessEpoch: f.policies.epoch(), expectedProposalSha256: p.body.proposal.proposalSha256 }, 'bob', randomUUID())).status, 403);
    assert.equal(f.store.detail(id).revision.currentVersion, 1);
  } finally { await f.close(); }
});
test('in-flight provider completion cannot disclose source after view revocation', async () => {
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const f = await fixture('/', async (input) => { entered(); await new Promise<void>(resolve => { release = resolve; }); return { result: { summary: 'Private completion', limitations: 'Synthetic', edits: [] }, providerResponseId: 'fixture', responseModel: input.model }; });
  try {
    const id = f.create().revision.id, path = `/api/revisions/${id}/ai-proposals`, input = f.input(id), key = randomUUID();
    const pending = f.request(path, 'POST', input, 'bob', key); await waiting;
    f.policy(id, { view: { kind: 'principals', principalIds: [f.alice.id] } }); release();
    const denied = await pending; assert.equal(denied.status, 404); assert.doesNotMatch(JSON.stringify(denied.body), /Private completion/);
    assert.equal((await f.request(path, 'POST', input, 'bob', key)).status, 404); assert.equal(f.calls(), 1);
    assert.equal(f.store.detail(id).revision.currentVersion, 1);
  } finally { await f.close(); }
});
