import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceClient, RequestError } from '../client/offline.ts';
import { activateSession, lockSession, SessionChangedError } from '../client/session.ts';
import { putRepositoryCache, repositoryCache } from '../client/repository-cache.ts';
import { createHash } from 'node:crypto';
import { gitPatchBytes } from '../shared/git-patch.ts';
import { patchCacheKey } from '../client/repository-patch.ts';
import type { ObjectAccess } from '../shared/policy.ts';
import type { GitPatch, GitCommit } from '../shared/repositories.ts';

const base = 'a'.repeat(40), target = 'b'.repeat(40), query = { base, target };
const person = { name: 'Private patch author', email: 'private@example.test', timestamp: '2026-01-01T00:00:00.000Z' };
const commit = (id: string): GitCommit => ({ id, treeId: (id === base ? 'c' : 'd').repeat(40), parentIds: [], author: person, committer: person, message: 'Private source message', messageTruncated: false });
const selection = { commitId: target, baseCommitId: base, path: '', view: 'changes' as const, beforePath: null, afterPath: null };
const route = `/api/repositories/R1/compare/patch?${new URLSearchParams(query)}`, cacheKey = 'repository:R1:cache', selectionKey = 'repository:R1:selection';
const access = (id: string): ObjectAccess => ({ policy: { objectId: id, spaceId: 'S1', version: 1, rules: { view: { kind: 'workspace' }, edit: { kind: 'workspace' }, interact: { kind: 'workspace' } } }, capabilities: { view: true, edit: true, interact: true, managePolicy: true }, viewLabel: 'Workspace', editLabel: 'Workspace', interactLabel: 'Workspace' });
const raw = Buffer.from('PRIVATE patch bytes\x00\xff', 'latin1');
const source = (epoch = 1): GitPatch => ({ repositoryId: 'R1', objectFormat: 'sha1', accessEpoch: epoch, format: 'git-binary-patch-v1', baseCommit: commit(base), targetCommit: commit(target), baseTreeId: commit(base).treeId, targetTreeId: commit(target).treeId, bytes: raw.length, sha256: createHash('sha256').update(raw).digest('hex'), dataBase64: raw.toString('base64') });
const cache = (epoch = 1) => putRepositoryCache(repositoryCache(null), patchCacheKey(query), source(epoch));
function fixture(mode: 'local' | 'password' = 'local') {
  const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'), win = Object.getOwnPropertyDescriptor(globalThis, 'window'), entries = new Map<string, string>(), events = new EventTarget(); let quota = false;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { get length() { return entries.size; }, key: (index: number) => [...entries.keys()][index] ?? null, getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { if (quota) throw new Error('Storage quota exhausted'); entries.set(key, value); }, removeItem: (key: string) => entries.delete(key) } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: events });
  const client = createWorkspaceClient(activateSession({ mode, workspaceId: 'patch-lifecycle', account: mode === 'password' ? { id: 'U1', username: 'alice', displayName: 'Alice', disabled: false } : null, sessionContext: mode === 'password' ? 'first-session' : null, csrfToken: mode === 'password' ? 'csrf' : null, expiresAt: null })); client.reconcileAccess({ R1: access('R1') }, 1, ['S1']);
  return { client, entries, quota: (value: boolean) => { quota = value; }, removeElsewhere() { const key = client.storageKey(cacheKey), oldValue = entries.get(key) ?? null; entries.delete(key); const event = new Event('storage'); Object.assign(event, { key, oldValue, newValue: null }); events.dispatchEvent(event); }, close() { lockSession(); if (storage) Object.defineProperty(globalThis, 'localStorage', storage); else Reflect.deleteProperty(globalThis, 'localStorage'); if (win) Object.defineProperty(globalThis, 'window', win); else Reflect.deleteProperty(globalThis, 'window'); } };
}

test('patch cache stores verified bytes only with their exact pair and access epoch', async () => {
  const current = fixture();
  try {
    const { client, entries } = current; assert.deepEqual(Buffer.from(await gitPatchBytes(source(), 'R1', query)), raw);
    client.writeStored(cacheKey, cache()); client.writeStored(selectionKey, { ...selection, dataBase64: source().dataBase64, sha256: source().sha256 });
    assert.deepEqual(client.readStored(selectionKey, null), selection);
    client.reconcileAccess({ R1: access('R1') }, 2, ['S1']); assert.equal(client.readStored(cacheKey, null), null); assert.equal(entries.has(client.storageKey(cacheKey)), false); assert.deepEqual(client.readStored(selectionKey, null), selection);
    assert.equal(client.writeStored(cacheKey, cache()), false); assert.equal(client.writeStored(cacheKey, cache(2)), true);
    client.reconcileAccess({}, 3, []); assert.equal(client.readStored(cacheKey, null), null); assert.equal(client.readStored(selectionKey, null), null);
  } finally { current.close(); }
});

test('already-decoding patch envelopes retire when an access epoch changes despite retained repository access', async () => {
  const current = fixture(), previous = globalThis.fetch; let release!: (value: unknown) => void, signal: AbortSignal | undefined;
  try {
    const response = Response.json({}); Object.defineProperty(response, 'json', { value: () => new Promise(resolve => { release = resolve; }) }); globalThis.fetch = async (_url, init) => { signal = init?.signal as AbortSignal; return response; };
    const pending = current.client.request(route); await new Promise<void>(resolve => setImmediate(resolve)); current.client.reconcileAccess({ R1: access('R1') }, 2, ['S1']);
    assert.equal(signal?.aborted, true); release(source()); await assert.rejects(pending, (error: unknown) => error instanceof RequestError && error.code === 'ACCESS_CHANGED'); assert.equal(current.client.writeStored(cacheKey, cache()), false);
  } finally { globalThis.fetch = previous; current.close(); }
});

test('cross-tab patch removal cancels pending export reads and notifies the prepared snapshot', async () => {
  const current = fixture(), previous = globalThis.fetch; let release!: (response: Response) => void, signal: AbortSignal | undefined, notifications = 0;
  try {
    const { client } = current; client.writeStored(cacheKey, cache()); client.writeStored(selectionKey, selection); client.onRepositorySnapshotChange(() => notifications++);
    globalThis.fetch = async (_url, init) => { signal = init?.signal as AbortSignal; return new Promise(resolve => { release = resolve; }); }; const pending = client.request(route);
    current.removeElsewhere(); assert.equal(signal?.aborted, true); assert.equal(notifications, 1); release(Response.json(source())); await assert.rejects(pending, /visibility changed|Access changed/i);
    assert.equal(client.readStored(cacheKey, null), null); assert.deepEqual(client.readStored(selectionKey, null), selection);
  } finally { globalThis.fetch = previous; current.close(); }
});

test('password patch bytes stay in the verified tab and cannot cross accounts or sessions', async () => {
  const current = fixture('password'), previous = globalThis.fetch; let release!: (response: Response) => void;
  try {
    current.client.writeStored(cacheKey, cache()); current.client.writeStored(selectionKey, selection); assert.equal(current.entries.size, 0);
    globalThis.fetch = async () => new Promise(resolve => { release = resolve; }); const pending = current.client.request(route);
    const next = createWorkspaceClient(activateSession({ mode: 'password', workspaceId: 'patch-lifecycle', account: { id: 'U2', username: 'bob', displayName: 'Bob', disabled: false }, sessionContext: 'next-session', csrfToken: 'csrf-next', expiresAt: null }));
    release(Response.json(source())); await assert.rejects(pending, SessionChangedError); assert.equal(next.readStored(cacheKey, null), null); assert.equal(next.readStored(selectionKey, null), null); assert.equal(current.entries.size, 0); assert.equal(current.client.writeStored(cacheKey, cache()), false);
  } finally { globalThis.fetch = previous; current.close(); }
});

test('Space and direct object denial remove quota-retained patch envelopes without replaying export or discarding drafts', async () => {
  for (const direct of [false, true]) {
    const current = fixture(), previous = globalThis.fetch; let calls = 0;
    try {
      const { client, entries } = current; client.writeStored(cacheKey, cache()); client.writeStored(selectionKey, selection);
      const draft = { title: 'My unsaved import', commitId: target }; client.writeStored('repository-import:R1', draft);
      current.quota(true); const memory = putRepositoryCache(cache(), patchCacheKey({ base: target, target: base }), { ...source(), baseCommit: commit(target), targetCommit: commit(base), baseTreeId: commit(target).treeId, targetTreeId: commit(base).treeId }); assert.equal(client.writeStored(cacheKey, memory), false);
      globalThis.fetch = async () => { calls++; return Response.json({ error: 'Unavailable', code: 'OBJECT_UNAVAILABLE' }, { status: 404 }); };
      if (direct) await assert.rejects(client.request(route), (error: unknown) => error instanceof RequestError && error.code === 'OBJECT_UNAVAILABLE'); else client.reconcileAccess({}, 2, []);
      assert.equal(client.readStored(cacheKey, null), null); assert.equal(client.readStored(selectionKey, null), null); assert.equal(entries.has(client.storageKey(cacheKey)), false);
      assert.deepEqual(client.quarantinedDrafts().find(item => item.key === 'repository-import:R1')?.value, draft);
      current.quota(false); client.reconcileAccess({ R1: access('R1') }, 3, ['S1']); assert.equal(client.readStored(cacheKey, null), null); assert.equal(client.draftIsHeld('repository-import:R1'), true); assert.equal(calls, direct ? 1 : 0, 'access recovery never replays an export');
    } finally { globalThis.fetch = previous; current.close(); }
  }
});
