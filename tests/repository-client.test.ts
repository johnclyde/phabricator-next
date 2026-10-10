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
  assert.equal(putRepositoryCache(cache, 'oversized', { accessEpoch: 2, source: 'x'.repeat(REPOSITORY_CACHE_LIMITS.bytes) }).entries.length, 0);
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
