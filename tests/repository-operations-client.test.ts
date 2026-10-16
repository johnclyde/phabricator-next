import test from 'node:test';
import assert from 'node:assert/strict';
import { repositorySyncIntent } from '../client/repository-operations.ts';
import { createWorkspaceClient } from '../client/offline.ts';
import { activateSession, lockSession } from '../client/session.ts';
import type { ObjectAccess } from '../shared/policy.ts';

const intent = { repositoryId: 'R1', requestId: 'same-request', input: { expectedConfiguration: 'a'.repeat(64), expectedAccessEpoch: 1 } };
const key = 'draft:repository-sync:R1:request';
const access: ObjectAccess = { policy: { objectId: 'R1', spaceId: 'S1', version: 1, rules: { view: { kind: 'workspace' }, edit: { kind: 'workspace' }, interact: { kind: 'workspace' } } }, capabilities: { view: true, edit: true, interact: true, managePolicy: true }, viewLabel: 'Workspace', editLabel: 'Workspace', interactLabel: 'Workspace' };
function client() { return createWorkspaceClient(activateSession({ mode: 'password', workspaceId: 'sync-tests', account: { id: 'alice', username: 'alice', displayName: 'Alice', disabled: false }, sessionContext: 'alice', csrfToken: 'csrf', expiresAt: null })); }

test('synchronization recovery accepts only exact source-free repository and configuration pins', () => {
  assert.deepEqual(repositorySyncIntent({ ...intent, remoteUrl: 'not retained', input: { ...intent.input, token: 'not retained' } }, 'R1'), intent);
  for (const invalid of [null, { ...intent, repositoryId: 'R2' }, { ...intent, requestId: 'bad\nrequest' }, { ...intent, input: { ...intent.input, expectedConfiguration: 'latest' } }, { ...intent, input: { ...intent.input, expectedAccessEpoch: -1 } }]) assert.equal(repositorySyncIntent(invalid, 'R1'), null);
});

test('exact sync recovery is quarantined when repository edit access is lost and never restored implicitly', async () => {
  try {
    const workspace = client(); workspace.reconcileAccess({ R1: access }, 1);
    assert.equal(await workspace.retainDraft(key, intent, null), 'saved');
    workspace.reconcileAccess({ R1: { ...access, capabilities: { ...access.capabilities, edit: false } } }, 2);
    assert.equal(workspace.readStored(key, null), null);
    assert.equal(workspace.quarantinedDrafts().some(draft => draft.key === key), true);
    workspace.reconcileAccess({ R1: access }, 3);
    assert.equal(workspace.readStored(key, null), null);
    assert.equal(await workspace.retainDraft(key, intent, null), 'unavailable');
  } finally { lockSession(); }
});

test('repository visibility loss retires retained sync requests from active state', async () => {
  try {
    const workspace = client(); workspace.reconcileAccess({ R1: access }, 1);
    assert.equal(await workspace.retainDraft(key, intent, null), 'saved');
    workspace.reconcileAccess({}, 2);
    assert.equal(workspace.readStored(key, null), null);
    assert.equal(workspace.quarantinedDrafts().some(draft => draft.key === key), true);
  } finally { lockSession(); }
});
