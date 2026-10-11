import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceClient, RequestError } from '../client/offline.ts';
import { activateSession, lockSession, SessionChangedError } from '../client/session.ts';
import { putRepositoryCache, repositoryCache } from '../client/repository-cache.ts';
import { validGitBlame } from '../shared/git-blame.ts';
import type { ObjectAccess } from '../shared/policy.ts';
import type { GitBlame, GitCommit } from '../shared/repositories.ts';

const commitId = 'a'.repeat(40), originId = 'b'.repeat(40), path = 'renamed/研究.md';
const person = { name: 'Private source author', email: 'private@example.test', timestamp: '2026-01-01T00:00:00.000Z' };
const origin: GitCommit = { id: originId, treeId: 'c'.repeat(40), parentIds: [], author: person, committer: person, message: 'Private attribution message', messageTruncated: false };
const selection = { commitId, path, view: 'blame' as const, selectedLine: 2 };
const route = `/api/repositories/R1/blame?${new URLSearchParams({ commit: commitId, path })}`, cacheKey = 'repository:R1:cache', selectionKey = 'repository:R1:selection';
const access = (id: string): ObjectAccess => ({ policy: { objectId: id, spaceId: 'S1', version: 1, rules: { view: { kind: 'workspace' }, edit: { kind: 'workspace' }, interact: { kind: 'workspace' } } }, capabilities: { view: true, edit: true, interact: true, managePolicy: true }, viewLabel: 'Workspace', editLabel: 'Workspace', interactLabel: 'Workspace' });
const source = (epoch = 1): GitBlame => ({ repositoryId: 'R1', objectFormat: 'sha1', accessEpoch: epoch, algorithm: 'git-blame-root', commit: { ...origin, id: commitId, parentIds: [originId] }, blob: { repositoryId: 'R1', objectFormat: 'sha1', commitId, path, objectId: 'd'.repeat(40), mode: '100644', state: 'text', content: 'PRIVATE\r\nlast', size: 13 }, lines: [{ lineNumber: 1, commitId: originId, originalLine: 7, path: 'old/source.md' }, { lineNumber: 2, commitId: originId, originalLine: 8, path: 'old/source.md' }], commits: [origin] });
const cache = (epoch = 1) => putRepositoryCache(repositoryCache(null), JSON.stringify(['blame', commitId, path]), source(epoch));
function fixture(mode: 'local' | 'password' = 'local') {
  const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'), win = Object.getOwnPropertyDescriptor(globalThis, 'window'), entries = new Map<string, string>(), events = new EventTarget();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { get length() { return entries.size; }, key: (index: number) => [...entries.keys()][index] ?? null, getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => entries.set(key, value), removeItem: (key: string) => entries.delete(key) } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: events });
  const client = createWorkspaceClient(activateSession({ mode, workspaceId: 'blame-lifecycle', account: mode === 'password' ? { id: 'U1', username: 'alice', displayName: 'Alice', disabled: false } : null, sessionContext: mode === 'password' ? 'first-session' : null, csrfToken: mode === 'password' ? 'csrf' : null, expiresAt: null })); client.reconcileAccess({ R1: access('R1') }, 1, ['S1']);
  return { client, entries, removeElsewhere() { const key = client.storageKey(cacheKey), oldValue = entries.get(key) ?? null; entries.delete(key); const event = new Event('storage'); Object.assign(event, { key, oldValue, newValue: null }); events.dispatchEvent(event); }, close() { lockSession(); if (storage) Object.defineProperty(globalThis, 'localStorage', storage); else Reflect.deleteProperty(globalThis, 'localStorage'); if (win) Object.defineProperty(globalThis, 'window', win); else Reflect.deleteProperty(globalThis, 'window'); } };
}

test('blame selection retains exact line navigation while epoch retirement removes both source and origin metadata', () => {
  const current = fixture();
  try {
    const { client, entries } = current; assert.equal(validGitBlame(source(), 'R1', commitId, path), true);
    client.writeStored(cacheKey, cache()); client.writeStored(selectionKey, { ...selection, author: person, originalPath: 'old/source.md', source: 'Must not become navigation metadata' });
    assert.deepEqual(client.readStored(selectionKey, null), selection);
    client.reconcileAccess({ R1: access('R1') }, 2, ['S1']); assert.equal(client.readStored(cacheKey, null), null); assert.equal(entries.has(client.storageKey(cacheKey)), false); assert.deepEqual(client.readStored(selectionKey, null), selection);
    assert.equal(client.writeStored(cacheKey, cache()), false); assert.equal(client.writeStored(cacheKey, cache(2)), true);
    client.reconcileAccess({}, 3, []); assert.equal(client.readStored(cacheKey, null), null); assert.equal(client.readStored(selectionKey, null), null);
  } finally { current.close(); }
});

test('already-decoding blame cannot return source or author metadata after a repository epoch change', async () => {
  const current = fixture(), previous = globalThis.fetch; let release!: (value: unknown) => void, signal: AbortSignal | undefined;
  try {
    const response = Response.json({}); Object.defineProperty(response, 'json', { value: () => new Promise(resolve => { release = resolve; }) }); globalThis.fetch = async (_url, init) => { signal = init?.signal as AbortSignal; return response; };
    const pending = current.client.request(route); await new Promise<void>(resolve => setImmediate(resolve)); current.client.reconcileAccess({ R1: access('R1') }, 2, ['S1']);
    assert.equal(signal?.aborted, true); release(source()); await assert.rejects(pending, (error: unknown) => error instanceof RequestError && error.code === 'ACCESS_CHANGED'); assert.equal(current.client.writeStored(cacheKey, cache()), false);
  } finally { globalThis.fetch = previous; current.close(); }
});

test('cross-tab blame cache retirement cancels the read without moving the exact selected line', async () => {
  const current = fixture(), previous = globalThis.fetch; let release!: (response: Response) => void, signal: AbortSignal | undefined, notifications = 0;
  try {
    const { client } = current; client.writeStored(cacheKey, cache()); client.writeStored(selectionKey, selection); client.onRepositorySnapshotChange(() => notifications++);
    globalThis.fetch = async (_url, init) => { signal = init?.signal as AbortSignal; return new Promise(resolve => { release = resolve; }); }; const pending = client.request(route);
    current.removeElsewhere(); assert.equal(signal?.aborted, true); assert.equal(notifications, 1); release(Response.json(source())); await assert.rejects(pending, /visibility changed|Access changed/i);
    assert.equal(client.readStored(cacheKey, null), null); assert.deepEqual(client.readStored(selectionKey, null), selection);
  } finally { globalThis.fetch = previous; current.close(); }
});

test('password blame snapshots are tab-local and cannot cross a session change', async () => {
  const current = fixture('password'), previous = globalThis.fetch; let release!: (response: Response) => void;
  try {
    current.client.writeStored(cacheKey, cache()); current.client.writeStored(selectionKey, selection); assert.equal(current.entries.size, 0);
    globalThis.fetch = async () => new Promise(resolve => { release = resolve; }); const pending = current.client.request(route);
    const next = createWorkspaceClient(activateSession({ mode: 'password', workspaceId: 'blame-lifecycle', account: { id: 'U2', username: 'bob', displayName: 'Bob', disabled: false }, sessionContext: 'next-session', csrfToken: 'csrf-next', expiresAt: null }));
    release(Response.json(source())); await assert.rejects(pending, SessionChangedError); assert.equal(next.readStored(cacheKey, null), null); assert.equal(next.readStored(selectionKey, null), null); assert.equal(current.entries.size, 0);
  } finally { globalThis.fetch = previous; current.close(); }
});
