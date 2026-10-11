import test from 'node:test';
import assert from 'node:assert/strict';
import { putRepositoryCache, repositoryCache, repositorySelection, REPOSITORY_CACHE_LIMITS } from '../client/repository-cache.ts';
import { createWorkspaceClient, RequestError } from '../client/offline.ts';
import { activateSession, lockSession } from '../client/session.ts';
import type { SessionState } from '../shared/auth.ts';
import type { ObjectAccess } from '../shared/policy.ts';

const commitId = 'a'.repeat(40);
const session = (mode: 'local' | 'password' = 'password', name = 'alice'): SessionState => ({ mode, workspaceId: 'repository-tests', account: mode === 'password' ? { id: name, username: name, displayName: name, disabled: false } : null, sessionContext: mode === 'password' ? name : null, csrfToken: mode === 'password' ? 'csrf' : null, expiresAt: null });
const access: ObjectAccess = { policy: { objectId: 'R1', spaceId: 'S1', version: 1, rules: { view: { kind: 'workspace' }, edit: { kind: 'workspace' }, interact: { kind: 'workspace' } } }, capabilities: { view: true, edit: true, interact: true, managePolicy: true }, viewLabel: 'Workspace', editLabel: 'Workspace', interactLabel: 'Workspace' };

test('repository selections whitelist exact commit identities and safe Git paths', () => {
  const selected = { commitId, path: 'unicodé/研究.md', view: 'file' as const };
  assert.deepEqual(repositorySelection({ ...selected, source: 'never persisted', branch: 'main' }), selected);
  assert.equal(repositorySelection({ ...selected, commitId: 'main' }), null);
  assert.equal(repositorySelection({ ...selected, path: '../secret' }), null);
  assert.equal(repositorySelection({ ...selected, view: ['file'] }), null);
  assert.deepEqual(repositorySelection({ ...selected, view: 'history', historyFrom: 'file' }), { ...selected, view: 'history', historyFrom: 'file' });
  assert.equal(repositorySelection({ ...selected, historyFrom: 'invalid' }), null);
  assert.deepEqual(repositorySelection({ ...selected, commitId: 'b'.repeat(64), path: '', view: 'tree' }), { commitId: 'b'.repeat(64), path: '', view: 'tree' });
});

test('repository cache evicts oldest exact snapshots under entry and byte bounds, and never mixes policy epochs', () => {
  let cache = repositoryCache(null);
  for (let index = 0; index < 20; index++) cache = putRepositoryCache(cache, String(index), { accessEpoch: 1, content: 'x'.repeat(180_000) });
  assert.ok(cache.entries.length < REPOSITORY_CACHE_LIMITS.entries);
  assert.ok(new TextEncoder().encode(JSON.stringify(cache)).length <= REPOSITORY_CACHE_LIMITS.bytes);
  assert.equal(cache.entries.at(-1)?.key, '19');
  cache = putRepositoryCache(cache, 'new-epoch', { accessEpoch: 2, content: 'current' });
  assert.deepEqual(cache.entries.map(entry => entry.key), ['new-epoch']);
  assert.deepEqual(repositoryCache({ entries: new Array(17).fill({ key: 'x', value: 1 }) }), { entries: [] });
  assert.deepEqual(repositoryCache({ entries: [{ key: 'x', value: 'No verified epoch' }] }), { entries: [] });
  assert.deepEqual(putRepositoryCache(cache, 'oversized', { accessEpoch: 2, source: 'x'.repeat(REPOSITORY_CACHE_LIMITS.bytes) }).entries, cache.entries);
});

test('repository source and metadata follow account lifetime, object revocation and unrelated epoch invalidation', () => {
  try {
    const client = createWorkspaceClient(activateSession(session())); client.reconcileAccess({ R1: access }, 1);
    client.writeStored('repository:R1:selection', { commitId, path: '', view: 'tree', content: 'excluded' });
    assert.deepEqual(client.readStored('repository:R1:selection', null), { commitId, path: '', view: 'tree' });
    client.writeStored('repository:R1:cache', { accessEpoch: 1, entries: [{ key: 'tree', value: { content: 'private source' } }] });
    client.reconcileAccess({ R1: access }, 2);
    assert.equal(client.readStored('repository:R1:cache', null), null);
    assert.notEqual(client.readStored('repository:R1:selection', null), null, 'an unrelated epoch clears source, not the pinned commit');
    assert.equal(client.writeStored('repository:R1:cache', { accessEpoch: 1, entries: [] }), false);
    client.reconcileAccess({}, 3);
    assert.equal(client.readStored('repository:R1:selection', null), null);
    activateSession(session('password', 'bob'));
    assert.equal(client.readStored('repository:R1:cache', null), null);
    assert.equal(client.writeStored('repository:R1:cache', { accessEpoch: 3, entries: [] }), false);
  } finally { lockSession(); }
});

test('late repository reads reject known access changes and Git missing objects do not revoke the visible repository', async () => {
  const previousFetch = globalThis.fetch;
  try {
    const client = createWorkspaceClient(activateSession(session())); client.reconcileAccess({ R1: access }, 1);
    let release!: (response: Response) => void;
    globalThis.fetch = async () => new Promise<Response>(resolve => { release = resolve; });
    const pending = client.request(`/api/repositories/R1/blob?commit=${commitId}&path=source.txt`);
    client.reconcileAccess({}, 2); client.reconcileAccess({ R1: access }, 3);
    release(Response.json({ repositoryId: 'R1', accessEpoch: 1, content: 'private source' }));
    await assert.rejects(pending, (error: unknown) => error instanceof RequestError && error.code === 'OBJECT_UNAVAILABLE');
    globalThis.fetch = async () => Response.json({ error: 'Git path unavailable', code: 'GIT_PATH_UNAVAILABLE' }, { status: 404 });
    await assert.rejects(client.request(`/api/repositories/R1/blob?commit=${commitId}&path=missing`), /Git path unavailable/);
    assert.equal(client.unavailableObject('R1'), false);
  } finally { globalThis.fetch = previousFetch; lockSession(); }
});

test('repository denial immediately purges linked revision/comparison snapshots and quarantines drafts before state refresh', async () => {
  const previousFetch = globalThis.fetch;
  try {
    const client = createWorkspaceClient(activateSession(session())); client.reconcileAccess({ R1: access, D1: access, D2: access }, 1);
    client.writeStored('revision:D1', { revision: { id: 'D1', repositoryId: 'R1' }, versions: [{ content: 'private source' }] });
    client.writeStored('revision-comparison:D1', { revisionId: 'D1', base: null, target: { id: 'v1', contentHash: 'hash' }, filePath: 'a.ts', mode: 'lines', view: 'source' });
    client.writeStored('revision:D2', { revision: { id: 'D2', repositoryId: null }, versions: [{ content: 'independent' }] });
    client.writeStored('version-draft:D1:v1', { files: [{ path: 'a.ts', content: 'unsaved source' }] });
    client.writeStored('comment-source:D1:v1', { body: 'unsaved comment' });
    client.writeStored('repository-import:R1', { input: { title: 'Import intent' }, requestId: 'same-id' });
    // A direct repository denial arrives while the old workspace state still
    // says D1 is visible. The dependency—not a later /state read—must revoke it.
    let signal: AbortSignal | undefined; let release!: (response: Response) => void;
    globalThis.fetch = async (_url, init) => { signal = init?.signal as AbortSignal; return new Promise(resolve => { release = resolve; }); };
    const pending = client.request('/api/revisions/D1');
    globalThis.fetch = async () => Response.json({ error: 'Unavailable', code: 'OBJECT_UNAVAILABLE' }, { status: 404 });
    await assert.rejects(client.request('/api/repositories/R1'), /unavailable/i);
    assert.equal(signal?.aborted, true);
    assert.equal(client.unavailableObject('D1'), true);
    assert.equal(client.readStored('revision:D1', null), null);
    assert.equal(client.readStored('revision-comparison:D1', null), null);
    assert.notEqual(client.readStored('revision:D2', null), null);
    assert.deepEqual(new Set(client.quarantinedDrafts().map(item => item.key)), new Set(['version-draft:D1:v1', 'comment-source:D1:v1', 'repository-import:R1']));
    release(Response.json({ revision: { id: 'D1', repositoryId: 'R1' }, versions: [{ content: 'late source' }], accessEpoch: 1 }));
    await assert.rejects(pending, (error: unknown) => error instanceof RequestError && error.code === 'OBJECT_UNAVAILABLE');
    client.reconcileAccess({ R1: access, D1: access, D2: access }, 2);
    assert.equal(client.readStored('version-draft:D1:v1', null), null, 'regaining access does not replay or restore held drafts');
    assert.equal(client.draftRecords().some(item => item.key === 'repository-import:R1'), true, 'session export includes retained import intent');
  } finally { globalThis.fetch = previousFetch; lockSession(); }
});

test('cached source dependencies survive local reopen and import requests never queue', async () => {
  const previousStorage = globalThis.localStorage; const previousFetch = globalThis.fetch;
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { get length() { return values.size; }, key: (index: number) => [...values.keys()][index] || null, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key), clear: () => values.clear() } });
  try {
    const first = createWorkspaceClient(activateSession(session('local'))); first.reconcileAccess({ R1: access, D1: access }, 1);
    first.writeStored('revision:D1', { revision: { id: 'D1', repositoryId: 'R1' }, versions: [{ content: 'cached source' }] });
    first.writeStored('version-draft:D1:v1', { content: 'keep this work' });
    const client = createWorkspaceClient(activateSession(session('local')));
    globalThis.fetch = async () => Response.json({ error: 'Unavailable', code: 'OBJECT_UNAVAILABLE' }, { status: 404 });
    await assert.rejects(client.request('/api/repositories/R1'), /unavailable/i);
    assert.equal(client.readStored('revision:D1', null), null);
    assert.equal(client.quarantinedDrafts()[0]?.key, 'version-draft:D1:v1');
    const reopened = createWorkspaceClient(activateSession(session('local')));
    assert.equal(reopened.quarantinedDrafts()[0]?.key, 'version-draft:D1:v1');
    await assert.rejects(reopened.request('/api/repositories/R1/import-revision', { method: 'POST', body: { testPlan: 'Fixture verification plan.', commitId, kind: 'code', title: 'Never autoqueue' }, queued: true, id: 'queued' }), /explicit online save/);
  } finally { globalThis.fetch = previousFetch; Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: previousStorage }); lockSession(); }
});

test('quota-failed revision, comment and reply copies remain distinct, recoverable and held across source revocation and reload', async () => {
  const previousStorage = globalThis.localStorage; const previousFetch = globalThis.fetch;
  const values = new Map<string, string>(); let failDrafts = false;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { get length() { return values.size; }, key: (index: number) => [...values.keys()][index] || null, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { if (failDrafts && /:(version-draft|comment-source):/.test(key)) throw new Error('Quota'); values.set(key, value); }, removeItem: (key: string) => values.delete(key), clear: () => values.clear() } });
  try {
    const client = createWorkspaceClient(activateSession(session('local'))); client.reconcileAccess({ R1: access, D1: access }, 1);
    client.writeStored('revision:D1', { revision: { id: 'D1', repositoryId: 'R1' } });
    const keys = ['version-draft:D1:1', 'comment-source:D1:v1', 'comment-source:D1:reply:thread:v1'];
    for (const key of keys) client.writeStored(key, { body: 'Earlier durable work', files: [{ path: 'a.ts', content: 'earlier source' }] });
    failDrafts = true;
    for (const key of keys) { assert.equal(client.writeStored(key, { body: 'Newest failed write', files: [{ path: 'a.ts', content: 'newest source' }] }), false); assert.equal(client.draftHasUnsavedMemory(key), true); }
    assert.equal(client.draftRecords().length, 3, 'volatile local copies participate in export and beforeunload protection');
    failDrafts = false;
    globalThis.fetch = async () => Response.json({ error: 'Unavailable', code: 'OBJECT_UNAVAILABLE' }, { status: 404 });
    await assert.rejects(client.request('/api/repositories/R1'), /unavailable/i);
    assert.equal(client.quarantinedDrafts().length, 6, 'both physical copies of every draft are secured');
    const reopened = createWorkspaceClient(activateSession(session('local'))); reopened.reconcileAccess({ R1: access, D1: access }, 2);
    assert.equal(reopened.quarantinedDrafts().length, 6);
    for (const key of keys) { assert.equal(reopened.draftIsHeld(key), true); assert.equal(reopened.readStored(key, null), null); }
    assert.equal(reopened.quarantinedDrafts().filter(item => JSON.stringify(item.value).includes('newest source')).length, 3);
  } finally { globalThis.fetch = previousFetch; Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: previousStorage }); lockSession(); }
});

test('successful revision and comment saves compare-clear each physical copy without erasing another tab’s newer draft', () => {
  const previousStorage = globalThis.localStorage; const values = new Map<string, string>(); let fail = false;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { get length() { return values.size; }, key: (index: number) => [...values.keys()][index] || null, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { if (fail) throw new Error('Quota'); values.set(key, value); }, removeItem: (key: string) => values.delete(key), clear: () => values.clear() } });
  try {
    const client = createWorkspaceClient(activateSession(session('local'))); client.reconcileAccess({ D1: access }, 1);
    for (const key of ['version-draft:D1:1', 'comment-source:D1:v1', 'comment-source:D1:reply:t:v1']) {
      const durable = { body: 'A different newer durable draft' }; const submitted = { body: 'Submitted failed-memory draft' };
      client.writeStored(key, durable); fail = true; assert.equal(client.writeStored(key, submitted), false); fail = false;
      assert.equal(client.removeStoredIfEqual(key, submitted), true); assert.deepEqual(client.readStored(key, null), durable);
      fail = true; client.writeStored(key, submitted); fail = false;
      assert.equal(client.removeStoredIfEqual(key, durable), true); assert.deepEqual(client.readStored(key, null), submitted);
    }
  } finally { Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: previousStorage }); lockSession(); }
});
