import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createWorkspaceClient, RequestError } from '../client/offline.ts';
import { activateSession, lockSession, SessionChangedError } from '../client/session.ts';
import { canonicalRevisionStack, type RevisionStack, type RevisionStackContent, type RevisionStackNode } from '../shared/revision-stack.ts';
import type { ObjectAccess } from '../shared/policy.ts';

const time = '2026-10-11T12:00:00Z', path = '/api/revisions/D1/dependencies/graph', key = 'revision-stack:D1';
const nodes: RevisionStackNode[] = ['D1', 'P2'].map((id, index) => ({ id, title: index ? 'Private parent title' : 'Source title', kind: index ? 'paper' : 'code', status: 'needs_review', currentVersion: 1, updatedAt: time, relationshipVersion: 1, head: { versionId: `${id}-v1`, number: 1, contentHash: 'a'.repeat(64) }, author: { principalId: 'U1', displayName: 'Original author' } }));
function graph(root = 'D1', overrides: Partial<RevisionStackContent> = {}): RevisionStack {
  const content: RevisionStackContent = { format: 'phabricator.revision-stack.v1', revisionId: root, accessEpoch: 1, nodes, edges: [{ childId: 'D1', parentId: 'P2' }], openParentIds: root === 'D1' ? ['P2'] : [], ...overrides };
  return { ...content, snapshotId: createHash('sha256').update(canonicalRevisionStack(content)).digest('hex') };
}
const access = (id: string): ObjectAccess => ({ policy: { objectId: id, version: 1, spaceId: 'S1', rules: { view: { kind: 'workspace' }, edit: { kind: 'workspace' }, interact: { kind: 'workspace' } } }, capabilities: { view: true, edit: false, interact: false, managePolicy: false }, viewLabel: 'Workspace', editLabel: 'Workspace', interactLabel: 'Workspace' });
const accessMap = { D1: access('D1'), P2: access('P2'), T1: access('T1'), F1: access('F1'), R1: access('R1') };
function fixture(mode: 'local' | 'password' = 'local') {
  const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'), win = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const entries = new Map<string, string>(), events = new EventTarget(); let quota = false;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { get length() { return entries.size; }, key: (index: number) => [...entries.keys()][index] ?? null, getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { if (quota) throw new Error('Quota'); entries.set(key, value); }, removeItem: (key: string) => entries.delete(key) } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: events });
  const session = activateSession({ mode, workspaceId: 'revision-stack', account: mode === 'password' ? { id: 'U1', username: 'reader', displayName: 'Reader', disabled: false } : null, sessionContext: mode === 'password' ? 'context' : null, csrfToken: mode === 'password' ? 'csrf' : null, expiresAt: null });
  const client = createWorkspaceClient(session); client.reconcileAccess(accessMap, 1, ['S1']); assert.equal(client.writeStored(key, graph()), true);
  return { client, session, entries, failWrites() { quota = true; }, removeElsewhere() { const storageKey = client.storageKey(key), oldValue = entries.get(storageKey) ?? null; entries.delete(storageKey); const event = new Event('storage'); Object.assign(event, { key: storageKey, oldValue, newValue: null }); events.dispatchEvent(event); }, close() { lockSession(); if (storage) Object.defineProperty(globalThis, 'localStorage', storage); else Reflect.deleteProperty(globalThis, 'localStorage'); if (win) Object.defineProperty(globalThis, 'window', win); else Reflect.deleteProperty(globalThis, 'window'); } };
}
const workspaceState = (revisions: unknown[] = nodes, access = accessMap, epoch = 1) => ({ revisions, access, accessEpoch: epoch, spaces: [{ id: 'S1' }] });

test('graph-only invalidation clears every stack and aborts graph reads without retiring ordinary source or task reads', async () => {
  const current = fixture(), previous = globalThis.fetch; const releases = new Map<string, (response: Response) => void>(), signals = new Map<string, AbortSignal>(); let graphEvents = 0, taskEvents = 0;
  try {
    const sourceAccess = access('D1'); current.client.reconcileAccess({ ...accessMap, D1: { ...sourceAccess, capabilities: { ...sourceAccess.capabilities, edit: true } } }, 1, ['S1']);
    current.client.writeStored('revision-stack:P2', graph('P2')); current.client.writeStored('version-draft:D1:1', { content: 'Keep original draft' });
    current.client.onRevisionStackChange(() => graphEvents++); current.client.onTaskSnapshotChange(() => taskEvents++);
    const twin = createWorkspaceClient(current.session);
    globalThis.fetch = async (url, init) => { signals.set(String(url), init!.signal as AbortSignal); return new Promise(resolve => { releases.set(String(url), resolve); }); };
    const pendingGraph = current.client.request(path), pendingTask = current.client.request('/api/tasks/T1'); const oldGeneration = current.client.revisionStackGeneration();
    twin.invalidateRevisionStacks();
    assert.equal(graphEvents, 1); assert.equal(taskEvents, 0); assert.equal(current.client.revisionStackGeneration(), oldGeneration + 1);
    assert.equal(signals.get(path)!.aborted, true); assert.equal(signals.get('/api/tasks/T1')!.aborted, false);
    releases.get(path)!(Response.json(graph())); releases.get('/api/tasks/T1')!(Response.json({ accessEpoch: 1, task: { id: 'T1' } }));
    await assert.rejects(pendingGraph, (error: unknown) => error instanceof RequestError && error.code === 'REVISION_STACK_CHANGED'); assert.ok(await pendingTask);
    assert.equal(current.client.readStored(key, null), null); assert.equal(current.client.readStored('revision-stack:P2', null), null);
    assert.deepEqual(current.client.readStored('version-draft:D1:1', null), { content: 'Keep original draft' });
  } finally { globalThis.fetch = previous; current.close(); }
});

test('a hidden graph peer retires graph labels without becoming a source dependency or denying the root read', async () => {
  const current = fixture(), previous = globalThis.fetch;
  try {
    assert.equal(current.session.revisionFiles.has('D1'), false); assert.equal(current.session.revisionRepositories.has('D1'), false);
    current.client.retireUnavailableObject('P2');
    assert.equal(current.client.unavailableObject('D1'), false); assert.equal(current.client.readStored(key, null), null);
    assert.equal(current.client.writeStored(key, graph()), false, 'known-hidden labels cannot be restored by a late caller');
    globalThis.fetch = async () => Response.json(graph('D1', { nodes: [nodes[0]!], edges: [], openParentIds: [] }));
    const fresh = await current.client.request<RevisionStack>(path); assert.equal(fresh.nodes.length, 1); assert.equal(fresh.nodes[0]!.id, 'D1');
    assert.equal([...current.entries.values()].some(value => value.includes('Private parent title')), false);
  } finally { globalThis.fetch = previous; current.close(); }
});

test('known historical File or repository denial retires a peer and its graph without hiding the independent root', () => {
  for (const dependency of ['F1', 'R1']) {
    const current = fixture();
    try {
      current.client.writeStored('revision:P2', { revision: { id: 'P2', repositoryId: dependency === 'R1' ? 'R1' : null }, versions: dependency === 'F1' ? [{ assets: [{ fileId: 'F1' }] }, { assets: [] }] : [] });
      current.client.retireUnavailableObject(dependency);
      assert.equal(current.client.unavailableObject('P2'), true); assert.equal(current.client.unavailableObject('D1'), false);
      assert.equal(current.client.readStored(key, null), null); assert.equal(current.client.readStored('revision:P2', null), null);
      assert.equal(current.session.revisionFiles.has('D1'), false);
    } finally { current.close(); }
  }
});

test('same-epoch workspace metadata changes retire graph snapshots and already-decoding graph responses', async () => {
  for (const change of [{ title: 'Changed title' }, { kind: 'document' }, { status: 'closed' }, { currentVersion: 2 }, { updatedAt: '2026-10-12T12:00:00Z' }]) {
    const current = fixture(), previous = globalThis.fetch; let release!: (data: unknown) => void, signal: AbortSignal | undefined;
    try {
      const response = Response.json({}); Object.defineProperty(response, 'json', { value: () => new Promise(resolve => { release = resolve; }) });
      globalThis.fetch = async (url, init) => { if (String(url) === '/api/state') return Response.json(workspaceState([nodes[0], { ...nodes[1], ...change }])); signal = init!.signal as AbortSignal; return response; };
      const pending = current.client.request(path); await new Promise<void>(resolve => setImmediate(resolve));
      await current.client.request('/api/state'); assert.equal(current.session.accessEpoch, 1); assert.equal(signal?.aborted, true);
      release(graph()); await assert.rejects(pending, (error: unknown) => error instanceof RequestError && error.code === 'REVISION_STACK_CHANGED'); assert.equal(current.client.readStored(key, null), null);
    } finally { globalThis.fetch = previous; current.close(); }
  }
});

test('metadata observations retire pending graph reads even when no graph has finished or been persisted', async () => {
  const current = fixture(), previous = globalThis.fetch; let release!: (response: Response) => void;
  try {
    current.client.removeStored(key);
    globalThis.fetch = async () => Response.json(workspaceState()); await current.client.request('/api/state');
    globalThis.fetch = async url => String(url) === '/api/state' ? Response.json(workspaceState([nodes[0], { ...nodes[1], status: 'closed' }])) : new Promise(resolve => { release = resolve; });
    const pending = current.client.request(path); await current.client.request('/api/state'); release(Response.json(graph()));
    await assert.rejects(pending, (error: unknown) => error instanceof RequestError && error.code === 'REVISION_STACK_CHANGED');
  } finally { globalThis.fetch = previous; current.close(); }
});

test('unchanged workspace refreshes do not repeatedly invalidate graph reads and graph epochs advance once', async () => {
  const current = fixture(), previous = globalThis.fetch; let invalidations = 0;
  try {
    current.client.onRevisionStackChange(() => invalidations++);
    globalThis.fetch = async () => Response.json(workspaceState()); await current.client.request('/api/state'); await current.client.request('/api/state'); assert.equal(invalidations, 0);
    globalThis.fetch = async () => Response.json(graph('D1', { accessEpoch: 2 }));
    assert.equal((await current.client.request<RevisionStack>(path)).accessEpoch, 2); assert.equal(invalidations, 1);
    await current.client.request(path); assert.equal(invalidations, 1, 'the response that advances epoch does not create a reload loop');
  } finally { globalThis.fetch = previous; current.close(); }
});

test('cross-tab removal and permission changes retire graph reads, including quota-failed cached snapshots', async () => {
  for (const cause of ['tab', 'epoch', 'missing'] as const) {
    const current = fixture(), previous = globalThis.fetch; let release!: (response: Response) => void, signal: AbortSignal | undefined;
    try {
      current.failWrites(); assert.equal(current.client.writeStored(key, graph('D1', { accessEpoch: 2 })), false);
      globalThis.fetch = async (_url, init) => { signal = init!.signal as AbortSignal; return new Promise(resolve => { release = resolve; }); };
      const pending = current.client.request(path);
      if (cause === 'tab') current.removeElsewhere(); else if (cause === 'epoch') current.client.reconcileAccess(accessMap, 2, ['S1']); else current.client.reconcileAccess({ D1: access('D1'), T1: access('T1') }, 1, ['S1']);
      assert.equal(signal?.aborted, true); release(Response.json(graph())); await assert.rejects(pending, RequestError);
      assert.equal(current.client.readStored(key, null), null); assert.equal(current.client.unavailableObject('D1'), false);
    } finally { globalThis.fetch = previous; current.close(); }
  }
});

test('stack cache shape and epoch are checked and password session changes erase metadata and late responses', async () => {
  const current = fixture('password'), previous = globalThis.fetch; let release!: (response: Response) => void;
  try {
    assert.equal(current.client.writeStored(key, { ...graph(), nodes: [...nodes, nodes[0]] }), false);
    assert.equal(current.client.writeStored(key, { ...graph(), openParentIds: [] }), false);
    assert.equal(current.client.writeStored(key, { ...graph(), accessEpoch: undefined }), false);
    current.client.reconcileAccess(accessMap, 2, ['S1']); assert.equal(current.client.writeStored(key, graph()), false);
    globalThis.fetch = async () => new Promise(resolve => { release = resolve; }); const pending = current.client.request(path);
    const next = createWorkspaceClient(activateSession({ mode: 'password', workspaceId: 'revision-stack', account: { id: 'U2', username: 'other', displayName: 'Other', disabled: false }, sessionContext: 'other-context', csrfToken: 'other-csrf', expiresAt: null }));
    release(Response.json(graph())); await assert.rejects(pending, SessionChangedError); assert.equal(next.readStored(key, null), null); assert.equal(current.entries.size, 0);
  } finally { globalThis.fetch = previous; current.close(); }
});
