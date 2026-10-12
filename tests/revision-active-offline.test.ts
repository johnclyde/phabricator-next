import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceClient } from '../client/offline.ts';
import { activateSession, lockSession } from '../client/session.ts';
import { evaluateRevisionActive } from '../shared/revision-active.ts';
import type { AppState } from '../shared/types.ts';
import type { ObjectAccess } from '../shared/policy.ts';
import type { SessionState } from '../shared/auth.ts';

const access: ObjectAccess = { policy: { objectId: 'P1', spaceId: 'S1', version: 1, rules: { view: { kind: 'workspace' }, edit: { kind: 'workspace' }, interact: { kind: 'workspace' } } }, capabilities: { view: true, edit: true, interact: true, managePolicy: true }, viewLabel: 'Workspace', editLabel: 'Workspace', interactLabel: 'Workspace' };
function state(principal: string): AppState {
  return { currentPrincipalId: principal, accessEpoch: 7, projects: [], repositories: [], tasks: [], documents: [], activity: [], spaces: [], principals: [], followingTaskIds: [], joinedProjectIds: [], watchingProjectIds: [], canCreate: true, ai: { configured: false, model: null }, mode: 'authenticated-workspace', revisions: [{ id: 'P1', kind: 'paper', title: 'Private title', summary: '', currentVersion: 1, status: 'needs_review', authorId: principal, authorVersion: 0, lifecycleVersion: 0, reviewerVersion: 0, repositoryId: null, projectId: null, createdAt: '2026-10-12T00:00:00Z', updatedAt: '2026-10-12T00:00:00Z' }], access: { P1: access }, revisionActive: { format: 'revision-active.v1', principalId: principal, accessEpoch: 7, closeOnAccept: false, items: [{ revisionId: 'P1', head: { versionId: 'v1', number: 1, contentHash: 'a'.repeat(64) }, status: 'needs_review', authorVersion: 0, lifecycleVersion: 0, reviewerVersion: 0, isAuthor: true, reviewerStatus: null, decisionCurrent: null }] } };
}
const identity = (name: string): SessionState => ({ mode: 'password', workspaceId: 'active-test', account: { id: name, username: name, displayName: name, disabled: false }, sessionContext: `context-${name}`, csrfToken: `csrf-${name}`, expiresAt: null });
function storage() {
  const values = new Map<string, string>(), previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { get length() { return values.size; }, key: (index: number) => [...values.keys()][index] ?? null, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) } });
  return { values, close: () => { lockSession(); if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else Reflect.deleteProperty(globalThis, 'localStorage'); } };
}
test('local Active snapshot reopens offline and View loss removes its entire cached projection', () => {
  const disk = storage();
  try {
    const session: SessionState = { mode: 'local', workspaceId: 'active-test', account: null, sessionContext: null, csrfToken: null, expiresAt: null };
    const value = state('local:active-test'), first = createWorkspaceClient(activateSession(session));
    first.reconcileAccess(value.access, 7); assert.equal(first.writeStored('state', value), true);
    first.writeStored('revision-list-mode:paper', { mode: 'active', query: 'Private' });
    const reopened = createWorkspaceClient(activateSession(session)), cached = reopened.readStored<AppState | null>('state', null);
    assert.ok(cached); assert.equal(evaluateRevisionActive(cached, 'paper').available, true);
    assert.deepEqual(reopened.readStored('revision-list-mode:paper', null), { mode: 'active', query: 'Private' });
    assert.deepEqual(reopened.draftRecords(), [], 'presentation is not authored content');
    reopened.reconcileAccess({}, 8);
    assert.equal(reopened.readStored('state', null), null);
    assert.equal([...disk.values.values()].some(value => value.includes('revision-active.v1')), false);
    assert.equal(evaluateRevisionActive({ ...cached, revisionActive: undefined }, 'paper').available, false, 'legacy cache does not become an empty Active queue');
  } finally { disk.close(); }
});
test('authenticated Active snapshots and presentation retire with the account session', () => {
  const disk = storage();
  try {
    const alice = createWorkspaceClient(activateSession(identity('alice')));
    alice.writeStored('state', state('alice')); alice.writeStored('revision-list-mode:paper', { mode: 'active', query: 'Private' });
    assert.equal(disk.values.size, 0);
    const bob = createWorkspaceClient(activateSession(identity('bob')));
    assert.equal(bob.readStored('state', null), null); assert.equal(bob.readStored('revision-list-mode:paper', null), null);
    assert.equal(alice.writeStored('state', state('alice')), false);
    assert.equal(alice.readStored('state', null), null);
  } finally { disk.close(); }
});

test('a delayed older same-epoch state cannot revoke newly visible revisions or quarantine their drafts', async () => {
  const previous = globalThis.fetch;
  try {
    const session = activateSession(identity('alice')), first = createWorkspaceClient(session), second = createWorkspaceClient(session);
    const releases: ((response: Response) => void)[] = [];
    globalThis.fetch = async () => new Promise<Response>(resolve => releases.push(resolve));
    first.reconcileAccess({}, 7);
    const old = first.request('/api/state'), fresh = second.request<AppState>('/api/state');
    const value = state('alice');
    releases[1]!(Response.json(value)); assert.deepEqual(await fresh, value);
    assert.equal(second.writeStored('state', value), true);
    await second.retainDraft('version-draft:P1', { files: [{ path: 'main.tex', content: 'Do not quarantine this newer draft.' }] }, null);
    const generation = second.revisionStackGeneration();
    releases[0]!(Response.json({ ...value, access: {}, revisions: [], revisionActive: { ...value.revisionActive, items: [] } }));
    await assert.rejects(old, error => error instanceof Error && 'code' in error && error.code === 'STATE_SUPERSEDED');
    assert.equal(session.unavailableObjects.has('P1'), false);
    assert.deepEqual(second.readStored('state', null), value);
    assert.deepEqual(second.quarantinedDrafts(), []);
    assert.equal(second.revisionStackGeneration(), generation);
  } finally { globalThis.fetch = previous; lockSession(); }
});
