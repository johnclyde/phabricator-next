import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceClient } from '../client/offline.ts';
import { activateSession, lockSession } from '../client/session.ts';
import type { FindingSelection } from '../client/finding-navigation-model.ts';
import type { SessionState } from '../shared/auth.ts';
import type { ObjectAccess } from '../shared/policy.ts';

const selection = (revisionId = 'L1'): FindingSelection => ({ revisionId, review: { kind: 'recorded', reviewId: 'review-one', versionId: 'source-one', contentHash: 'a'.repeat(64) }, findingId: 'local-1' });
const onDeviceSelection = (revisionId = 'L1'): FindingSelection => ({ revisionId, review: { kind: 'on-device', analysisId: 'ephemeral-one', versionId: 'source-one', contentHash: 'a'.repeat(64) }, findingId: 'local-1' });
const access = (objectId: string): ObjectAccess => ({ policy: { objectId, spaceId: 'S1', version: 1, rules: { view: { kind: 'workspace' }, edit: { kind: 'workspace' }, interact: { kind: 'workspace' } } }, capabilities: { view: true, edit: true, interact: true, managePolicy: true }, viewLabel: 'Workspace members', editLabel: 'Workspace members', interactLabel: 'Workspace members' });
const account = (name: string): SessionState => ({ mode: 'password', workspaceId: 'finding-navigation-storage', account: { id: name, username: name, displayName: name, disabled: false }, sessionContext: `context-${name}`, csrfToken: `csrf-${name}`, expiresAt: null });
function storageFixture() {
  const stored = new Map<string, string>(), previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { get length() { return stored.size; }, key: (index: number) => [...stored.keys()][index] ?? null, getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value), removeItem: (key: string) => stored.delete(key) } });
  const state: SessionState = { mode: 'local', workspaceId: 'finding-navigation-storage', account: null, sessionContext: null, csrfToken: null, expiresAt: null };
  return { stored, reopen: () => createWorkspaceClient(activateSession(state)), close: () => { lockSession(); if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else Reflect.deleteProperty(globalThis, 'localStorage'); } };
}

test('finding navigation stores only exact pins and preferences, and rejects invalid replacement without losing the chosen review', () => {
  const storage = storageFixture();
  try {
    let client = storage.reopen(); const readOnly = access('L1'); readOnly.capabilities = { view: true, edit: false, interact: false, managePolicy: false }; client.reconcileAccess({ L1: readOnly }, 1);
    const choice = selection();
    assert.equal(client.writeStored('review-findings:L1', { ...choice, review: { ...choice.review, analysis: 'private review result' }, source: 'private source', finding: { body: 'private finding body' } }), true);
    assert.deepEqual(client.readStored('review-findings:L1', null), choice);
    assert.equal(storage.stored.get(client.storageKey('review-findings:L1'))?.includes('private'), false);
    assert.deepEqual(client.draftRecords(), []);
    assert.deepEqual(client.readStored('outbox', []), []);
    for (const invalid of [null, { ...choice, revisionId: 'L2' }, { ...choice, review: { ...choice.review, contentHash: 'wrong' } }, { ...choice, review: { ...choice.review, kind: 'latest' } }, { ...choice, findingId: 42 }]) {
      assert.equal(client.writeStored('review-findings:L1', invalid), false);
      assert.deepEqual(client.readStored('review-findings:L1', null), choice);
    }
    client = storage.reopen();
    assert.deepEqual(client.readStored('review-findings:L1', null), choice);
    // A malformed stored pin must reach the finding resolver; it must not become a missing choice and silently select a newer run.
    const corrupt = { ...choice, review: { ...choice.review, contentHash: 'corrupt' } };
    storage.stored.set(client.storageKey('review-findings:L1'), JSON.stringify(corrupt));
    assert.deepEqual(client.readStored('review-findings:L1', null), corrupt);
  } finally { storage.close(); }
});

test('on-device choices persist only a retired-result marker and never restore an older recorded run implicitly', () => {
  const storage = storageFixture();
  try {
    let client = storage.reopen(); client.reconcileAccess({ L1: access('L1') }, 1);
    client.writeStored('review-findings:L1', selection());
    const chosen = onDeviceSelection();
    assert.equal(client.writeStored('review-findings:L1', { ...chosen, review: { ...chosen.review, analysis: { summary: 'private unrecorded checks' } }, finding: { body: 'private finding text' } }), true);
    assert.equal(storage.stored.get(client.storageKey('review-findings:L1'))?.includes('private'), false);
    client = storage.reopen();
    assert.deepEqual(client.readStored('review-findings:L1', null), chosen);
    assert.deepEqual(client.draftRecords(), []);
    assert.deepEqual(client.readStored('outbox', []), []);
  } finally { storage.close(); }
});

test('repository access loss retires a finding choice and cached original source without holding the choice as authored work', () => {
  const storage = storageFixture();
  try {
    let client = storage.reopen(); client.reconcileAccess({ L1: access('L1'), R1: access('R1') }, 1);
    client.writeStored('revision:L1', { revision: { id: 'L1', repositoryId: 'R1' }, versions: [{ files: [{ path: 'motion.md', content: 'original source' }] }], accessEpoch: 1 });
    client.writeStored('review-findings:L1', onDeviceSelection());
    client = storage.reopen(); client.reconcileAccess({ L1: access('L1'), R1: access('R1') }, 1);
    client.retireUnavailableObject('R1');
    assert.equal(client.unavailableObject('L1'), true);
    assert.equal(client.readStored('review-findings:L1', null), null);
    assert.equal(client.readStored('revision:L1', null), null);
    assert.equal(storage.stored.has(client.storageKey('review-findings:L1')), false);
    assert.equal(client.writeStored('review-findings:L1', onDeviceSelection()), false);
    assert.deepEqual(client.quarantinedDrafts(), []);
  } finally { storage.close(); }
});

test('historical review source loss clears saved finding choices across reopen even after a new head uses another File', () => {
  const storage = storageFixture();
  try {
    let client = storage.reopen();
    client.reconcileAccess({ L1: access('L1'), L2: access('L2'), F1: access('F1'), F2: access('F2') }, 1);
    client.writeStored('revision:L1', { revision: { id: 'L1' }, versions: [{ assets: [{ fileId: 'F1' }], files: [{ path: 'paper.tex', content: 'historical source' }] }], accessEpoch: 1 });
    client.writeStored('review-findings:L1', selection());
    client.writeStored('review-findings:L2', selection('L2'));
    client.writeStored('comment-source:L2:source-two', { body: 'Keep unrelated draft' });
    // A later detail must retain every historical source dependency, including when only its newest version is in this response.
    client.writeStored('revision:L1', { revision: { id: 'L1' }, versions: [{ assets: [{ fileId: 'F2' }], files: [{ path: 'paper.tex', content: 'new head source' }] }], accessEpoch: 1 });
    client = storage.reopen();
    client.reconcileAccess({ L1: access('L1'), L2: access('L2'), F1: access('F1'), F2: access('F2') }, 1);
    assert.deepEqual(client.readStored('review-findings:L1', null), selection());
    client.retireUnavailableObject('F1');
    assert.equal(client.unavailableObject('L1'), true);
    assert.equal(client.readStored('revision:L1', null), null);
    assert.equal(client.readStored('review-findings:L1', null), null);
    assert.equal(storage.stored.has(client.storageKey('review-findings:L1')), false);
    assert.equal(client.writeStored('review-findings:L1', selection()), false);
    assert.deepEqual(client.readStored('review-findings:L2', null), selection('L2'));
    assert.deepEqual(client.readStored('comment-source:L2:source-two', null), { body: 'Keep unrelated draft' });
    assert.deepEqual(client.quarantinedDrafts(), []);
  } finally { storage.close(); }
});

test('finding navigation metadata is retired on revision access loss without becoming a recoverable source draft', () => {
  const storage = storageFixture();
  try {
    const client = storage.reopen(); client.reconcileAccess({ L1: access('L1'), L2: access('L2') }, 1);
    client.writeStored('review-findings:L1', selection()); client.writeStored('review-findings:L2', selection('L2'));
    client.reconcileAccess({ L2: access('L2') }, 2);
    assert.equal(client.readStored('review-findings:L1', null), null);
    assert.equal(storage.stored.has(client.storageKey('review-findings:L1')), false);
    assert.deepEqual(client.readStored('review-findings:L2', null), selection('L2'));
    assert.deepEqual(client.quarantinedDrafts(), []);
  } finally { storage.close(); }
});

test('protected finding choices stay in memory and cannot be read or rewritten after account replacement or lock', () => {
  const storage = storageFixture();
  try {
    const session = activateSession(account('alice')), client = createWorkspaceClient(session);
    assert.equal(client.writeStored('review-findings:L1', selection()), true);
    assert.deepEqual(client.readStored('review-findings:L1', null), selection());
    assert.equal([...storage.stored.keys()].some(key => key.includes('review-findings:')), false);
    const nextSession = activateSession(account('bob')), next = createWorkspaceClient(nextSession);
    assert.equal(client.readStored('review-findings:L1', null), null);
    assert.equal(client.writeStored('review-findings:L1', selection()), false);
    assert.equal(session.memory.size, 0);
    assert.equal(next.readStored('review-findings:L1', null), null);
    next.writeStored('review-findings:L1', selection()); lockSession();
    assert.equal(next.readStored('review-findings:L1', null), null);
    assert.equal(next.writeStored('review-findings:L1', selection()), false);
    assert.equal(nextSession.memory.size, 0);
  } finally { storage.close(); }
});
