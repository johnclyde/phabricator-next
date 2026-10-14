import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { canQueue, createWorkspaceClient } from '../client/offline.ts';
import { activateSession, lockSession, SessionChangedError } from '../client/session.ts';
import type { ObjectAccess } from '../shared/policy.ts';
const versionId = randomUUID(), principalId = 'local:ai-proposal-lifecycle';
const access = (id: string, edit = true, interact = true): ObjectAccess => ({ policy: { objectId: id, version: 1, spaceId: 'S1', rules: { view: { kind: 'workspace' }, edit: { kind: 'workspace' }, interact: { kind: 'workspace' } } }, capabilities: { view: true, edit, interact, managePolicy: edit }, viewLabel: 'Workspace', editLabel: 'Workspace', interactLabel: 'Workspace' });
const key = `ai-proposal-draft:L1:${versionId}`, requestKey = 'ai-proposal-request:L1';
const draft = { revisionId: 'L1', principalId, versionId, contentHash: 'a'.repeat(64), instruction: 'Preserve these exact instructions 😀\r\n', scope: null };
const input = { provider: 'openai', model: 'fixture', instruction: draft.instruction, expectedHead: { versionId, contentHash: draft.contentHash, number: 1 }, expectedAccessEpoch: 1, scope: null, allowHosted: true };
const intent = { id: randomUUID(), revisionId: 'L1', principalId, kind: 'generate', proposalId: null, input };
function fixture(mode: 'local' | 'password' = 'local') {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'); const entries = new Map<string, string>(); let quota = false;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { get length() { return entries.size; }, key: (index: number) => [...entries.keys()][index] ?? null, getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { if (quota) throw new Error('Quota'); entries.set(key, value); }, removeItem: (key: string) => entries.delete(key) } });
  const session = activateSession({ mode, workspaceId: 'ai-proposal-lifecycle', account: mode === 'password' ? { id: principalId, username: 'writer', displayName: 'Writer', disabled: false } : null, sessionContext: mode === 'password' ? 'session-one' : null, csrfToken: mode === 'password' ? 'csrf-one' : null, expiresAt: null });
  const client = createWorkspaceClient(session); client.reconcileAccess({ L1: access('L1'), F1: access('F1'), R1: access('R1') }, 1, ['S1']);
  return { client, session, entries, failWrites: () => { quota = true; }, close: () => { lockSession(); if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor); else Reflect.deleteProperty(globalThis, 'localStorage'); } };
}
test('AI instructions and uncertain operations cannot be queued or impersonate another principal', async () => {
  const f = fixture(), previous = globalThis.fetch; let sent = 0;
  try {
    globalThis.fetch = async () => { sent++; return Response.json({}); };
    assert.equal(canQueue('/api/revisions/L1/ai-proposals', 'POST', input), false);
    await assert.rejects(f.client.request('/api/revisions/L1/ai-proposals', { method: 'POST', body: input, id: intent.id, queued: true }), /explicit online save/);
    assert.equal(sent, 0); assert.equal(f.client.writeStored(key, { ...draft, principalId: 'other' }), false); assert.equal(f.client.writeStored(requestKey, { ...intent, result: 'Private generated text' }), false);
    assert.equal(f.client.writeStored(key, draft), true); assert.equal(f.client.writeStored(requestKey, intent), true);
  } finally { globalThis.fetch = previous; f.close(); }
});
for (const dependency of ['L1', 'F1', 'R1']) test(`AI drafts retain exact export bytes after ${dependency} source revocation`, () => {
  const f = fixture();
  try {
    f.session.revisionFiles.set('L1', new Set(['F1'])); f.session.revisionRepositories.set('L1', 'R1');
    f.client.writeStored(key, draft); f.client.writeStored(requestKey, intent); f.client.retireUnavailableObject(dependency);
    for (const [name, value] of [[key, draft], [requestKey, intent]] as const) { assert.equal(f.client.readStored(name, null), null); assert.equal(f.client.draftIsHeld(name), true); assert.deepEqual(f.client.quarantinedDrafts().find(row => row.key === name)!.value, value); }
    f.client.reconcileAccess({ L1: access('L1'), F1: access('F1'), R1: access('R1') }, 2, ['S1']); assert.equal(f.client.draftIsHeld(requestKey), true);
  } finally { f.close(); }
});
test('proposal generation retains interact authority while applying requires edit authority', () => {
  const f = fixture();
  try {
    f.client.writeStored(key, draft); f.client.writeStored(requestKey, intent);
    f.client.reconcileAccess({ L1: access('L1', false, true), F1: access('F1'), R1: access('R1') }, 2, ['S1']);
    assert.deepEqual(f.client.readStored(key, null), draft); assert.deepEqual(f.client.readStored(requestKey, null), intent);
    f.client.removeStored(requestKey);
    const apply = { ...intent, id: randomUUID(), kind: 'apply', proposalId: randomUUID(), input: { expectedHead: input.expectedHead, expectedAccessEpoch: 2, expectedProposalSha256: 'b'.repeat(64) } };
    f.client.writeStored(requestKey, apply); assert.equal(f.client.readStored(requestKey, null), null); assert.equal(f.client.draftIsHeld(requestKey), true);
    f.client.reconcileAccess({ L1: access('L1', false, false), F1: access('F1'), R1: access('R1') }, 3, ['S1']); assert.equal(f.client.draftIsHeld(key), true);
  } finally { f.close(); }
});
test('quota failure keeps both original and unsaved AI instructions available for export', () => {
  const f = fixture();
  try {
    f.client.writeStored(key, draft); f.failWrites(); const next = { ...draft, instruction: 'Newer exact instructions' };
    assert.equal(f.client.writeStored(key, next), false); assert.equal(f.client.draftHasUnsavedMemory(key), true);
    f.client.retireUnavailableObject('L1'); const values = f.client.quarantinedDrafts().map(row => row.value);
    assert.ok(values.some(v => JSON.stringify(v) === JSON.stringify(draft))); assert.ok(values.some(v => JSON.stringify(v) === JSON.stringify(next)));
  } finally { f.close(); }
});
test('password proposal drafts stay memory-only and a late private read cannot cross logout', async () => {
  const f = fixture('password'), previous = globalThis.fetch; let release!: (r: Response) => void;
  try {
    f.client.writeStored(key, draft); f.client.writeStored(requestKey, intent); assert.equal(f.entries.size, 0);
    globalThis.fetch = async () => new Promise<Response>(resolve => { release = resolve; });
    const pending = f.client.request('/api/revisions/L1/ai-proposals'); lockSession(); release(Response.json({ accessEpoch: 1, items: [{ instruction: 'Private' }] }));
    await assert.rejects(pending, SessionChangedError); assert.equal(f.session.memory.size, 0); assert.equal(f.entries.size, 0);
  } finally { globalThis.fetch = previous; f.close(); }
});
test('a late proposal response cannot restore text after an access epoch change', async () => {
  const f = fixture(), previous = globalThis.fetch; let release!: (r: Response) => void;
  try {
    globalThis.fetch = async () => new Promise<Response>(resolve => { release = resolve; });
    const pending = f.client.request('/api/revisions/L1/ai-proposals');
    f.client.reconcileAccess({ L1: access('L1'), F1: access('F1'), R1: access('R1') }, 2, ['S1']);
    release(Response.json({ accessEpoch: 1, items: [{ instruction: 'Private' }] })); await assert.rejects(pending, /changed|older|stale|access/i);
  } finally { globalThis.fetch = previous; f.close(); }
});
