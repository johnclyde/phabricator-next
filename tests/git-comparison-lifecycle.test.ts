import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceClient, RequestError } from '../client/offline.ts';
import { activateSession, lockSession, SessionChangedError } from '../client/session.ts';
import { putRepositoryCache, repositoryCache, type RepositorySelection } from '../client/repository-cache.ts';
import { comparisonCacheKey, comparisonQuery } from '../client/repository-comparison.ts';
import type { ObjectAccess } from '../shared/policy.ts';

const base = 'a'.repeat(40), target = 'b'.repeat(40);
const selection: RepositorySelection = { commitId: target, baseCommitId: base, path: '', view: 'changes', beforePath: 'before/研究.md', afterPath: 'after/研究.md' };
const access = (id: string): ObjectAccess => ({ policy: { objectId: id, spaceId: 'S1', version: 1, rules: { view: { kind: 'workspace' }, edit: { kind: 'workspace' }, interact: { kind: 'workspace' } } }, capabilities: { view: true, edit: true, interact: true, managePolicy: true }, viewLabel: 'Workspace', editLabel: 'Workspace', interactLabel: 'Workspace' });
const grants = () => ({ R1: access('R1'), D1: access('D1') });
const cacheKey = 'repository:R1:cache', selectionKey = 'repository:R1:selection';
const source = (epoch = 1) => ({ repositoryId: 'R1', accessEpoch: epoch, base, target, content: 'PRIVATE exact committed source' });
const savedCache = (epoch = 1) => putRepositoryCache(putRepositoryCache(repositoryCache(null), comparisonCacheKey(selection), source(epoch)), comparisonCacheKey(selection, true), source(epoch));
const endpoint = (file: boolean) => `/api/repositories/R1/compare${file ? '/file' : ''}?${comparisonQuery(selection, file)}`;

function fixture(mode: 'local' | 'password' = 'local') {
  const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'), windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const entries = new Map<string, string>(), events = new EventTarget(); let quota = false;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { get length() { return entries.size; }, key: (index: number) => [...entries.keys()][index] ?? null, getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { if (quota) throw new Error('Quota'); entries.set(key, value); }, removeItem: (key: string) => entries.delete(key) } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: events });
  const client = createWorkspaceClient(activateSession({ mode, workspaceId: 'comparison-lifecycle', account: mode === 'password' ? { id: 'U1', username: 'alice', displayName: 'Alice', disabled: false } : null, sessionContext: mode === 'password' ? 'session-one' : null, csrfToken: mode === 'password' ? 'csrf-one' : null, expiresAt: null }));
  client.reconcileAccess(grants(), 1, ['S1']);
  return {
    client, entries, quota: (value: boolean) => { quota = value; },
    removeInOtherTab(key: string) { const physical = client.storageKey(key), oldValue = entries.get(physical) ?? null; entries.delete(physical); const event = new Event('storage'); Object.assign(event, { key: physical, oldValue, newValue: null }); events.dispatchEvent(event); },
    close() { lockSession(); if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor); else Reflect.deleteProperty(globalThis, 'localStorage'); if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor); else Reflect.deleteProperty(globalThis, 'window'); },
  };
}

test('comparison caches retain ordered pairs and exact path tuples while selection persists only immutable navigation metadata', () => {
  const current = fixture();
  try {
    const { client } = current; const cache = savedCache();
    assert.notEqual(comparisonCacheKey(selection), comparisonCacheKey({ ...selection, baseCommitId: target, commitId: base }));
    assert.notEqual(comparisonCacheKey(selection, true), comparisonCacheKey({ ...selection, beforePath: null }, true));
    assert.equal(client.writeStored(cacheKey, cache), true);
    assert.equal(client.writeStored(selectionKey, { ...selection, content: 'Do not persist source as navigation', branch: 'main' }), true);
    assert.deepEqual(client.readStored(selectionKey, null), selection);
    assert.equal(client.readStored<typeof cache | null>(cacheKey, null)?.entries.length, 2);
    client.reconcileAccess(grants(), 2, ['S1']);
    assert.equal(client.readStored(cacheKey, null), null); assert.equal(current.entries.has(client.storageKey(cacheKey)), false);
    assert.deepEqual(client.readStored(selectionKey, null), selection, 'unrelated policy changes retain the selected commit pair');
    assert.equal(client.writeStored(cacheKey, cache), false, 'a retired comparison cannot repopulate offline source');
    assert.equal(client.writeStored(cacheKey, savedCache(2)), true);
  } finally { current.close(); }
});

test('inventory and changed-file responses already decoding retire across access epochs even when repository access remains', async () => {
  for (const file of [false, true]) {
    const current = fixture(), previous = globalThis.fetch; let release!: (value: unknown) => void, signal: AbortSignal | undefined;
    try {
      const response = Response.json({}); Object.defineProperty(response, 'json', { value: () => new Promise(resolve => { release = resolve; }) });
      globalThis.fetch = async (_url, init) => { signal = init?.signal as AbortSignal; return response; };
      const pending = current.client.request(endpoint(file)); await new Promise<void>(resolve => setImmediate(resolve));
      current.client.reconcileAccess(grants(), 2, ['S1']); assert.equal(signal?.aborted, true); release(source());
      await assert.rejects(pending, (error: unknown) => error instanceof RequestError && error.code === 'ACCESS_CHANGED');
      assert.equal(current.client.writeStored(cacheKey, savedCache()), false);
    } finally { globalThis.fetch = previous; current.close(); }
  }
});

test('a direct comparison denial retires pair and file source, linked revisions and pending reads before workspace refresh', async () => {
  const current = fixture(), previous = globalThis.fetch; let release!: (response: Response) => void, signal: AbortSignal | undefined;
  try {
    const { client } = current; client.writeStored(cacheKey, savedCache()); client.writeStored(selectionKey, selection);
    client.writeStored('revision:D1', { revision: { id: 'D1', repositoryId: 'R1' }, versions: [{ content: 'Imported PRIVATE source' }] });
    const draft = { title: 'Keep my import intent', commitId: target }; client.writeStored('repository-import:R1', draft);
    globalThis.fetch = async (_url, init) => { signal = init?.signal as AbortSignal; return new Promise(resolve => { release = resolve; }); };
    const pending = client.request(endpoint(true));
    globalThis.fetch = async () => Response.json({ error: 'Repository unavailable.', code: 'OBJECT_UNAVAILABLE' }, { status: 404 });
    await assert.rejects(client.request(endpoint(false)), (error: unknown) => error instanceof RequestError && error.code === 'OBJECT_UNAVAILABLE');
    assert.equal(signal?.aborted, true); assert.equal(client.unavailableObject('R1'), true); assert.equal(client.unavailableObject('D1'), true);
    for (const key of [cacheKey, selectionKey, 'revision:D1']) assert.equal(client.readStored(key, null), null);
    assert.deepEqual(client.quarantinedDrafts().find(item => item.key === 'repository-import:R1')?.value, draft);
    release(Response.json(source())); await assert.rejects(pending, (error: unknown) => error instanceof RequestError && error.code === 'OBJECT_UNAVAILABLE');
    client.reconcileAccess(grants(), 2, ['S1']); assert.equal(client.readStored(cacheKey, null), null); assert.equal(client.draftIsHeld('repository-import:R1'), true);
  } finally { globalThis.fetch = previous; current.close(); }
});

test('removing comparison source in another tab retires both read kinds and notifies the rendered snapshot', async () => {
  const current = fixture(), previous = globalThis.fetch; const releases: Array<(response: Response) => void> = [], signals: AbortSignal[] = []; let retirements = 0;
  try {
    const { client } = current; client.writeStored(cacheKey, savedCache()); client.onRepositorySnapshotChange(() => retirements++);
    globalThis.fetch = async (_url, init) => { signals.push(init?.signal as AbortSignal); return new Promise(resolve => releases.push(resolve)); };
    const inventory = client.request(endpoint(false)), file = client.request(endpoint(true));
    current.removeInOtherTab(cacheKey); assert.equal(retirements, 1); assert.equal(client.readStored(cacheKey, null), null); assert.equal(signals.length, 2); assert.ok(signals.every(signal => signal.aborted));
    releases.forEach(release => release(Response.json(source())));
    await assert.rejects(inventory, /visibility changed|Access changed/i); await assert.rejects(file, /visibility changed|Access changed/i);
  } finally { globalThis.fetch = previous; current.close(); }
});

test('password comparison source stays in session memory and late source cannot cross accounts', async () => {
  const current = fixture('password'), previous = globalThis.fetch; let release!: (response: Response) => void;
  try {
    const { client, entries } = current; client.writeStored(cacheKey, savedCache()); client.writeStored(selectionKey, selection); assert.equal(entries.size, 0);
    globalThis.fetch = async () => new Promise(resolve => { release = resolve; }); const pending = client.request(endpoint(true));
    const next = createWorkspaceClient(activateSession({ mode: 'password', workspaceId: 'comparison-lifecycle', account: { id: 'U2', username: 'bob', displayName: 'Bob', disabled: false }, sessionContext: 'session-two', csrfToken: 'csrf-two', expiresAt: null }));
    release(Response.json(source())); await assert.rejects(pending, SessionChangedError);
    assert.equal(next.readStored(cacheKey, null), null); assert.equal(next.readStored(selectionKey, null), null); assert.equal(client.writeStored(cacheKey, savedCache()), false); assert.equal(entries.size, 0);
  } finally { globalThis.fetch = previous; current.close(); }
});

test('Space revocation removes quota-failed comparison caches while preserving distinct authored work', () => {
  const current = fixture();
  try {
    const { client, entries } = current; const key = 'repository-import:R1', durable = { title: 'Earlier intent', commitId: base }, retained = { title: 'Newer intent', commitId: target };
    client.writeStored(cacheKey, savedCache()); client.writeStored(selectionKey, selection); client.writeStored(key, durable);
    current.quota(true); assert.equal(client.writeStored(cacheKey, savedCache(2)), false); assert.equal(client.writeStored(key, retained), false);
    client.reconcileAccess({}, 2, []);
    assert.equal(client.readStored(cacheKey, null), null); assert.equal(entries.has(client.storageKey(cacheKey)), false); assert.equal(client.readStored(selectionKey, null), null);
    const drafts = client.quarantinedDrafts().filter(item => item.key === key || item.key === `${key}:unsaved-memory`).map(item => item.value);
    assert.equal(drafts.length, 2); assert.ok(drafts.some(value => JSON.stringify(value) === JSON.stringify(durable))); assert.ok(drafts.some(value => JSON.stringify(value) === JSON.stringify(retained)));
    current.quota(false); client.reconcileAccess(grants(), 3, ['S1']); assert.equal(client.readStored(cacheKey, null), null); assert.equal(client.draftIsHeld(key), true);
  } finally { current.close(); }
});
