import test from 'node:test';
import assert from 'node:assert/strict';
import { canQueue, createWorkspaceClient } from '../client/offline.ts';
import { activateSession, lockSession } from '../client/session.ts';
import type { ObjectAccess } from '../shared/policy.ts';

const access = (id: string, edit = true): ObjectAccess => ({ policy: { objectId: id, version: 1, spaceId: 'S1', rules: { view: { kind: 'workspace' }, edit: { kind: 'workspace' }, interact: { kind: 'workspace' } } }, capabilities: { view: true, edit, interact: true, managePolicy: edit }, viewLabel: 'Workspace', editLabel: 'Workspace', interactLabel: 'Workspace' });
const keys = ['draft:landing:D1:prepare', 'draft:automation:landing:D1:request', 'draft:automation:revision-builds:D1:request'];
function fixture() { const session = activateSession({ mode: 'password', workspaceId: 'landing-client', account: { id: 'U1', username: 'author', displayName: 'Author', disabled: false }, sessionContext: 'context', csrfToken: 'csrf', expiresAt: null }); const client = createWorkspaceClient(session); client.reconcileAccess({ D1: access('D1'), R1: access('R1') }, 1, ['S1']); client.writeStored('revision:D1', { revision: { id: 'D1', repositoryId: 'R1' }, versions: [] }); return { client, session }; }

test('landing and exact-version build intentions are held when revision edit or repository view is lost', () => {
  for (const reason of ['edit', 'repository'] as const) {
    const { client } = fixture();
    try {
      for (const key of keys) assert.equal(client.writeStored(key, { original: key, expectedContentHash: 'a'.repeat(64) }), true);
      if (reason === 'edit') client.reconcileAccess({ D1: access('D1', false), R1: access('R1') }, 2, ['S1']); else client.retireUnavailableObject('R1');
      for (const key of keys) { assert.equal(client.draftIsHeld(key), true, key); assert.deepEqual(client.quarantinedDrafts().find(draft => draft.key === key)?.value, { original: key, expectedContentHash: 'a'.repeat(64) }); }
      client.reconcileAccess({ D1: access('D1'), R1: access('R1') }, 3, ['S1']); for (const key of keys) assert.equal(client.draftIsHeld(key), true, 'Regrant never replays retained work.');
    } finally { lockSession(); }
  }
});

test('repository edit loss holds landing but leaves a readable revision build request independently recoverable', () => {
  const { client } = fixture();
  try {
    for (const key of keys) client.writeStored(key, { original: key });
    client.reconcileAccess({ D1: access('D1'), R1: access('R1', false) }, 2, ['S1']);
    assert.equal(client.draftIsHeld(keys[0]!), true); assert.equal(client.draftIsHeld(keys[1]!), true); assert.equal(client.draftIsHeld(keys[2]!), false);
    for (const path of ['/api/revisions/D1/landings', '/api/landings/LAND-example/commands', '/api/harbormaster/builds', '/api/drydock/leases']) assert.equal(canQueue(path, 'POST', {}), false, path);
  } finally { lockSession(); }
});
