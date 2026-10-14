import test from 'node:test';
import assert from 'node:assert/strict';
import { aiProposalDetailForVersion, aiProposalDraft, aiProposalIntent, aiProposalScopeMatches, type AIProposalDraft, type AIProposalIntent } from '../client/ai-proposal-client.ts';
import { createPassageAnchor } from '../shared/anchors.ts';
import type { RevisionVersion } from '../shared/types.ts';
const version: RevisionVersion = { id: 'a0000000-0000-4000-8000-000000000001', revisionId: 'L1', number: 1, contentHash: 'a'.repeat(64), files: [{ path: 'draft.tex', content: 'First statement.\r\nSecond 😀 argument.\n' }], createdAt: '2026-10-14T00:00:00Z', message: 'Initial source' };
const scope = createPassageAnchor(version, 'draft.tex', { start: 18, end: 37, quote: 'Second 😀 argument.' });
const draft: AIProposalDraft = { revisionId: 'L1', principalId: 'U1', versionId: version.id, contentHash: version.contentHash, instruction: 'Keep exact claims.\r\n  ', scope };
const intent: AIProposalIntent = { id: 'b0000000-0000-4000-8000-000000000002', revisionId: 'L1', principalId: 'U1', kind: 'generate', proposalId: null, input: { provider: 'openai', model: 'test-only-model', instruction: draft.instruction, expectedHead: { versionId: version.id, number: 1, contentHash: version.contentHash }, expectedAccessEpoch: 1, scope, allowHosted: true } };

test('authored AI instruction remains exact, account-bound and source-bound without accepting generated result data', () => {
  assert.deepEqual(aiProposalDraft(draft, 'L1', 'U1'), draft);
  assert.equal(aiProposalDraft(draft, 'L1', 'U2'), null);
  assert.equal(aiProposalDraft({ ...draft, versionId: 'another-version' }, 'L1', 'U1'), null);
  assert.equal(aiProposalDraft({ ...draft, result: { edits: [] } }, 'L1', 'U1'), null);
  assert.deepEqual(aiProposalDraft({ ...draft, instruction: '' }, 'L1', 'U1'), { ...draft, instruction: '' }, 'unfinished authored instructions can be retained');
});

test('exact generation recovery cannot change provider consent or smuggle a generated private response into storage', () => {
  assert.deepEqual(aiProposalIntent(intent, 'L1', 'U1'), intent);
  assert.equal(aiProposalIntent({ ...intent, input: { ...intent.input, allowHosted: false } }, 'L1', 'U1'), null);
  assert.equal(aiProposalIntent({ ...intent, input: { ...intent.input, provider: 'ollama' } }, 'L1', 'U1'), null);
  assert.equal(aiProposalIntent({ ...intent, result: { privateModelText: 'Never persist' } }, 'L1', 'U1'), null);
  assert.equal(aiProposalIntent({ ...intent, input: { ...intent.input, scope: { ...scope, contentHash: 'b'.repeat(64) } } }, 'L1', 'U1'), null);
  assert.equal(aiProposalIntent(intent, 'L1', 'U2'), null);
});

test('apply retry pins the full proposal digest and original current source without carrying replacement text', () => {
  const apply: AIProposalIntent = { ...intent, kind: 'apply', proposalId: 'c0000000-0000-4000-8000-000000000003', input: { expectedHead: intent.input.expectedHead, expectedAccessEpoch: 1, expectedProposalSha256: 'c'.repeat(64) } };
  assert.deepEqual(aiProposalIntent(apply, 'L1', 'U1'), apply);
  assert.equal(aiProposalIntent({ ...apply, input: { ...apply.input, edits: [] } }, 'L1', 'U1'), null);
  assert.equal(aiProposalIntent({ ...apply, input: { ...apply.input, expectedProposalSha256: 'invalid' } }, 'L1', 'U1'), null);
});

test('a quote copied into a newer version is not authority to generate against or apply to that version', () => {
  assert.equal(aiProposalScopeMatches(version, scope), true);
  assert.equal(aiProposalScopeMatches(version, Object.fromEntries(Object.entries(scope).reverse()) as unknown as typeof scope), true, 'property order is not source identity');
  assert.equal(aiProposalScopeMatches({ ...version, id: 'd0000000-0000-4000-8000-000000000004', number: 2 }, scope), false);
  assert.equal(aiProposalScopeMatches({ ...version, files: [{ path: 'draft.tex', content: 'Different text' }] }, scope), false);
  assert.equal(aiProposalScopeMatches(version, { ...scope, prefix: 'different context' }), false);
});

import { createWorkspaceClient, canQueue, retainedDraftLockName } from '../client/offline.ts';
import { activateSession, lockSession } from '../client/session.ts';
import type { ObjectAccess } from '../shared/policy.ts';
const permission = (interact = true, edit = true): ObjectAccess => ({ policy: { objectId: 'L1', version: 1, spaceId: 'S1', rules: { view: { kind: 'workspace' }, edit: { kind: 'workspace' }, interact: { kind: 'workspace' } } }, capabilities: { view: true, edit, interact, managePolicy: false }, viewLabel: 'Workspace', editLabel: 'Workspace', interactLabel: 'Workspace' });
function clientFixture(protectedSession = false) {
  const descriptors = Object.fromEntries(['localStorage', 'navigator', 'fetch'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)])), values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { get length() { return values.size; }, key: (index: number) => [...values.keys()][index] ?? null, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: async (_name: string, action: () => unknown) => action() } } });
  const session = activateSession({ mode: protectedSession ? 'password' : 'local', workspaceId: 'ai-proposal-storage', account: protectedSession ? { id: 'U1', username: 'alice', displayName: 'Alice', disabled: false } : null, sessionContext: protectedSession ? 'protected-session' : null, csrfToken: protectedSession ? 'csrf' : null, expiresAt: null });
  const client = createWorkspaceClient(session), principalId = protectedSession ? 'U1' : 'local:ai-proposal-storage'; client.reconcileAccess({ L1: permission() }, 1, ['S1']);
  return { client, session, values, principalId, draft: { ...draft, principalId }, intent: { ...intent, principalId }, close: () => { lockSession(); for (const [name, descriptor] of Object.entries(descriptors)) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); } } };
}
const draftKey = `ai-proposal-draft:L1:${version.id}`, requestKey = 'ai-proposal-request:L1';
test('AI authored drafts and exact recovery requests preserve competing tabs and never join the replay queue', async () => {
  const f = clientFixture(); try {
    assert.equal(retainedDraftLockName(draftKey), `file-intent:${draftKey}`); assert.equal(retainedDraftLockName(requestKey), `file-intent:${requestKey}`);
    assert.equal(await f.client.retainDraft(draftKey, f.draft, null), 'saved'); assert.equal(await f.client.retainDraft(requestKey, f.intent, null), 'saved');
    const newer = { ...f.draft, instruction: 'A newer instruction in another tab' }; f.values.set(f.client.storageKey(draftKey), JSON.stringify(newer));
    assert.deepEqual(f.client.readStored(draftKey, null), f.draft); assert.equal(await f.client.removeRetainedDraftIfEqual(draftKey, f.draft), true); assert.deepEqual(JSON.parse(f.values.get(f.client.storageKey(draftKey))!), newer);
    assert.equal(canQueue('/api/revisions/L1/ai-proposals', 'POST', f.intent.input), false); assert.equal(canQueue('/api/revisions/L1/ai-proposals/a0000000-0000-4000-8000-000000000001/apply', 'POST', {}), false);
  } finally { f.close(); }
});
test('Interact revocation retires generation drafts and preserves exact bytes for explicit export', async () => {
  const f = clientFixture(); try {
    await f.client.retainDraft(draftKey, f.draft, null); await f.client.retainDraft(requestKey, f.intent, null);
    f.client.reconcileAccess({ L1: permission(false, true) }, 2, ['S1']);
    assert.equal(f.client.readStored(draftKey, null), null); assert.equal(f.client.readStored(requestKey, null), null);
    assert.ok(f.client.quarantinedDrafts().some(item => item.key === draftKey && JSON.stringify(item.value) === JSON.stringify(f.draft)));
    assert.ok(f.client.quarantinedDrafts().some(item => item.key === requestKey && JSON.stringify(item.value) === JSON.stringify(f.intent)));
  } finally { f.close(); }
});
test('protected AI drafts remain session-only and disappear with account replacement', async () => {
  const f = clientFixture(true); try {
    await f.client.retainDraft(draftKey, f.draft, null); await f.client.retainDraft(requestKey, f.intent, null); assert.equal(f.values.size, 0);
    const other = createWorkspaceClient(activateSession({ ...f.session.state, account: { id: 'U2', username: 'bob', displayName: 'Bob', disabled: false }, sessionContext: 'different-session' }));
    assert.equal(f.session.memory.size, 0); assert.equal(other.readStored(draftKey, null), null); assert.equal(other.readStored(requestKey, null), null); assert.equal(f.client.writeStored(draftKey, f.draft), false);
  } finally { f.close(); }
});
test('late private proposal reads retire when source access changes before the response returns', async () => {
  const f = clientFixture(true); let release!: () => void, called!: () => void; const hold = new Promise<void>(resolve => { release = resolve; }), arrived = new Promise<void>(resolve => { called = resolve; });
  try {
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: async () => { called(); await hold; return new Response(JSON.stringify({ privateSource: 'Do not expose', accessEpoch: 1 }), { status: 200, headers: { 'Content-Type': 'application/json' } }); } });
    const reading = f.client.request('/api/revisions/L1/ai-proposals'); const rejection = assert.rejects(reading, /visibility changed|Access changed|unavailable/i); await arrived; f.client.retireUnavailableObject('L1'); release(); await rejection;
  } finally { release?.(); f.close(); }
});

test('complete private preview rejects forged quotations, another owner, and edits outside the disclosed selected passage', () => {
  const detail = { proposal: { id: 'c0000000-0000-4000-8000-000000000003', revisionId: 'L1', principalId: 'U1', status: 'ready', request: intent.input, createdAt: '2026-10-14T00:00:00Z', completedAt: '2026-10-14T00:00:01Z', provenance: { provider: 'openai', model: 'test-only-model', responseModel: 'test-model', providerResponseId: 'fixture', promptVersion: '1', sourceSha256: 'b'.repeat(64) }, result: { summary: 'Exact replacement', limitations: 'Fixture only', edits: [{ anchor: scope, replacement: 'Second precise argument.', explanation: 'Clarify wording.' }] }, proposalSha256: 'c'.repeat(64), failure: null, applied: null }, currentHead: intent.input.expectedHead, accessEpoch: 1, canApply: true, stale: false };
  assert.deepEqual(aiProposalDetailForVersion(detail, 'L1', 'U1', version), detail);
  assert.equal(aiProposalDetailForVersion(detail, 'L1', 'U2', version), null);
  const forged = structuredClone(detail); forged.proposal.result.edits[0]!.anchor = { ...scope, quote: 'Wrong quoted text!!' };
  assert.equal(aiProposalDetailForVersion(forged, 'L1', 'U1', version), null);
  const outside = structuredClone(detail); outside.proposal.result.edits[0]!.anchor = createPassageAnchor(version, 'draft.tex', { start: 0, end: 16, quote: 'First statement.' });
  assert.equal(aiProposalDetailForVersion(outside, 'L1', 'U1', version), null);
});
