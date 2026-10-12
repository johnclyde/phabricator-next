import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { parseGitVersionIntent } from '../client/GitVersionImport.tsx';
import { canQueue, createWorkspaceClient, RequestError } from '../client/offline.ts';
import { activateSession, lockSession } from '../client/session.ts';
import type { SessionState } from '../shared/auth.ts';
import type { ObjectAccess } from '../shared/policy.ts';

const state = (mode: 'local' | 'password' = 'password', account = 'alice'): SessionState => ({ mode, workspaceId: 'git-version-tests', account: mode === 'local' ? null : { id: account, username: account, displayName: account, disabled: false }, sessionContext: account, csrfToken: 'csrf', expiresAt: null });
const policy: ObjectAccess = { policy: { objectId: 'D1', spaceId: 'S1', version: 1, rules: { view: { kind: 'workspace' }, edit: { kind: 'workspace' }, interact: { kind: 'workspace' } } }, capabilities: { view: true, edit: true, interact: true, managePolicy: true }, viewLabel: 'Workspace', editLabel: 'Workspace', interactLabel: 'Workspace' };
const source = { ...policy, capabilities: { view: true, edit: false, interact: false, managePolicy: false } };
let navigatorDescriptor: PropertyDescriptor | undefined;
beforeEach(() => { navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator'); Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: async (_name: string, commit: () => unknown) => commit() } } }); });
afterEach(() => { if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor); else Reflect.deleteProperty(globalThis, 'navigator'); });
const draft = { revisionId: 'D1', repositoryId: 'R1', requestId: 'exact-request', attempted: true, input: { commitId: 'a'.repeat(40), expectedVersion: 1, expectedVersionId: 'immutable-v1', expectedContentHash: 'hash-1', message: 'Import the pinned tree' } };

test('Git version intent preserves exact retry pins and incomplete unsubmitted entry without copying extra source', () => {
  assert.deepEqual(parseGitVersionIntent({ ...draft, source: 'excluded', input: { ...draft.input, files: ['excluded'] } }, 'D1', 'R1'), draft);
  assert.notEqual(parseGitVersionIntent({ ...draft, attempted: false, input: { ...draft.input, commitId: 'partial-id' } }, 'D1', 'R1'), null);
  for (const patch of [{ revisionId: 'D2' }, { repositoryId: 'R2' }, { attempted: 'yes' }, { input: { ...draft.input, expectedVersion: 0 } }, { input: { ...draft.input, expectedVersionId: '' } }, { input: { ...draft.input, expectedContentHash: '' } }]) assert.equal(parseGitVersionIntent({ ...draft, ...patch }, 'D1', 'R1'), null);
});

test('version intent requires target edit and source view, remains session-bound, and never queues', async () => {
  const oldFetch = globalThis.fetch;
  try {
    const client = createWorkspaceClient(activateSession(state())); client.reconcileAccess({ D1: policy, R1: source }, 1);
    assert.equal(client.writeStored('revision-git-import:D1', draft), true); assert.deepEqual(client.readStored('revision-git-import:D1', null), draft);
    globalThis.fetch = async () => Response.json({ revision: { id: 'D1', repositoryId: 'R1' }, accessEpoch: 1 });
    await client.request('/api/revisions/D1/import-git', { method: 'POST', body: draft.input, id: draft.requestId }, ['R1']);
    assert.equal(canQueue('/api/revisions/D1/import-git', 'POST', draft.input), false);
    await assert.rejects(client.request('/api/revisions/D1/import-git', { method: 'POST', body: draft.input, id: draft.requestId, queued: true }), /explicit online save/);
    client.reconcileAccess({ D1: { ...policy, capabilities: { ...policy.capabilities, edit: false } }, R1: source }, 2);
    assert.equal(client.draftIsHeld('revision-git-import:D1'), true); assert.deepEqual(client.quarantinedDrafts()[0]?.value, draft); assert.equal(client.draftRecords().some(item => item.key === 'revision-git-import:D1'), true);
    const next = createWorkspaceClient(activateSession(state('password', 'bob'))); assert.deepEqual(next.draftRecords(), []); assert.equal(client.readStored('revision-git-import:D1', null), null);
  } finally { globalThis.fetch = oldFetch; lockSession(); }
});

test('local Git version intent keeps both quota-failed and durable copies through source loss and regrant', async () => {
  const previousStorage = globalThis.localStorage; const oldFetch = globalThis.fetch; const values = new Map<string, string>(); let fail = false;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { get length() { return values.size; }, key: (index: number) => [...values.keys()][index] || null, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { if (fail && key.includes('revision-git-import:')) throw new Error('quota'); values.set(key, value); }, removeItem: (key: string) => values.delete(key), clear: () => values.clear() } });
  try {
    const client = createWorkspaceClient(activateSession(state('local'))); client.reconcileAccess({ D1: policy, D2: policy, R1: source }, 1);
    const key = 'revision-git-import:D1'; const newer = { ...draft, requestId: 'another-request', input: { ...draft.input, message: 'Newer memory request' } };
    client.writeStored(key, draft); client.writeStored('version-draft:D2:1', { files: [{ path: 'separate.txt', content: 'Unrelated draft' }] }); fail = true; assert.equal(client.writeStored(key, newer), false); fail = false;
    let release!: (response: Response) => void; globalThis.fetch = async () => new Promise(resolve => { release = resolve; }); const pending = client.request('/api/revisions/D1/import-git', { method: 'POST', body: draft.input, id: draft.requestId }, ['R1']);
    client.reconcileAccess({ D1: policy, D2: policy }, 2); release(Response.json({ revision: { id: 'D1', repositoryId: 'R1' }, accessEpoch: 1 })); await assert.rejects(pending, (error: unknown) => error instanceof RequestError);
    assert.equal(client.quarantinedDrafts().length, 2); const next = createWorkspaceClient(activateSession(state('local'))); next.reconcileAccess({ D1: policy, D2: policy, R1: source }, 3);
    assert.equal(next.draftIsHeld(key), true); assert.equal(next.quarantinedDrafts().length, 2); assert.notEqual(next.readStored('version-draft:D2:1', null), null);
    await next.discardQuarantinedDraft(`${key}:unsaved-memory`); assert.equal(next.quarantinedDrafts().length, 1); assert.deepEqual(next.quarantinedDrafts()[0]!.value, draft);
  } finally { globalThis.fetch = oldFetch; Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: previousStorage }); lockSession(); }
});

test('a version-import receipt must prove its exact base, imported identity and Git provenance before clearing recovery', async () => {
  const { importedGitVersion } = await import('../client/GitVersionImport.tsx');
  const detail = { revision: { id: 'D1', repositoryId: 'R1' }, versions: [{ revisionId: 'D1', number: 1, id: draft.input.expectedVersionId, contentHash: draft.input.expectedContentHash }, { revisionId: 'D1', number: 2, id: 'v2', contentHash: 'hash-2', message: draft.input.message, gitSource: { kind: 'git', scope: 'complete-text-tree', repositoryId: 'R1', objectFormat: 'sha1', commitId: draft.input.commitId, treeId: 'b'.repeat(40) } }] } as unknown as import('../shared/types').RevisionDetail;
  assert.equal(importedGitVersion(detail, draft)?.id, 'v2');
  const wrongBase = structuredClone(detail); wrongBase.versions[0]!.contentHash = 'different'; assert.equal(importedGitVersion(wrongBase, draft), null);
  for (const patch of [{ revisionId: 'D2' }, { message: 'Another operation' }, { gitSource: { ...detail.versions[1]!.gitSource, scope: 'partial-tree' } }, { gitSource: { ...detail.versions[1]!.gitSource, treeId: 'main' } }, { gitSource: { ...detail.versions[1]!.gitSource, objectFormat: 'sha256' } }]) { const invalid = structuredClone(detail); Object.assign(invalid.versions[1]!, patch); assert.equal(importedGitVersion(invalid, draft), null); }
});

test('independent submitted request records survive replacement of the ordinary draft and remain source-scoped', () => {
  try {
    const client = createWorkspaceClient(activateSession(state())); client.reconcileAccess({ D1: policy, R1: source }, 1);
    const key = 'revision-git-import:D1'; const submittedKey = `${key}:submitted:${draft.requestId}`;
    client.writeStored(submittedKey, draft); client.writeStored(key, { ...draft, attempted: false, requestId: 'newer-draft', input: { ...draft.input, message: 'Newer unsent draft' } });
    assert.deepEqual(client.savedDraftRecords(`${key}:submitted:`), [{ key: submittedKey, value: draft }]);
    assert.equal(client.draftRecords().some(item => item.key === submittedKey), true);
    client.removeStored(key); client.reconcileAccess({ D1: policy }, 2); client.reconcileAccess({ D1: policy, R1: source }, 3);
    assert.deepEqual(client.savedDraftRecords(`${key}:submitted:`), []); assert.equal(client.quarantinedDrafts()[0]?.key, submittedKey, 'retained request remains discoverable even when ordinary form draft no longer exists');
  } finally { lockSession(); }
});
