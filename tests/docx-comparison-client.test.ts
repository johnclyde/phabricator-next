import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceClient } from '../client/offline.ts';
import { activateSession, lockSession } from '../client/session.ts';
import type { DocxComparisonSelection } from '../client/docx-comparison-model.ts';
import type { SessionState } from '../shared/auth.ts';
import type { ObjectAccess } from '../shared/policy.ts';

const selection = (revisionId = 'L1'): DocxComparisonSelection => ({ revisionId, base: { id: 'word-one', contentHash: 'a'.repeat(64), packageSha256: 'b'.repeat(64) }, target: { id: 'word-two', contentHash: 'c'.repeat(64), packageSha256: 'd'.repeat(64) }, filePath: 'footnotes', mode: 'words', view: 'changes', skipSpaceTabOnly: true });
const access = (objectId: string): ObjectAccess => ({ policy: { objectId, spaceId: 'S1', version: 1, rules: { view: { kind: 'workspace' }, edit: { kind: 'workspace' }, interact: { kind: 'workspace' } } }, capabilities: { view: true, edit: true, interact: true, managePolicy: true }, viewLabel: 'Workspace members', editLabel: 'Workspace members', interactLabel: 'Workspace members' });
const account = (name: string): SessionState => ({ mode: 'password', workspaceId: 'word-comparison-storage', account: { id: name, username: name, displayName: name, disabled: false }, sessionContext: `context-${name}`, csrfToken: `csrf-${name}`, expiresAt: null });
function storageFixture() {
  const stored = new Map<string, string>(), previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { get length() { return stored.size; }, key: (index: number) => [...stored.keys()][index] ?? null, getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value), removeItem: (key: string) => stored.delete(key) } });
  const state: SessionState = { mode: 'local', workspaceId: 'word-comparison-storage', account: null, sessionContext: null, csrfToken: null, expiresAt: null };
  return { stored, reopen: () => createWorkspaceClient(activateSession(state)), close: () => { lockSession(); if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else Reflect.deleteProperty(globalThis, 'localStorage'); } };
}

test('Word comparison stores only exact pins and preferences, and rejects invalid replacement without losing the chosen pair', () => {
  const storage = storageFixture();
  try {
    let client = storage.reopen(); client.reconcileAccess({ L1: access('L1') }, 1);
    const choice = selection();
    assert.equal(client.writeStored('docx-comparison:L1', { ...choice, base: { ...choice.base, source: 'private base source' }, target: { ...choice.target, projection: 'private target projection' }, source: 'private source', result: { segments: ['private result'] } }), true);
    assert.deepEqual(client.readStored('docx-comparison:L1', null), choice);
    assert.equal(storage.stored.get(client.storageKey('docx-comparison:L1'))?.includes('private'), false);
    assert.deepEqual(client.draftRecords(), []);
    assert.deepEqual(client.readStored('outbox', []), []);
    for (const invalid of [null, { ...choice, revisionId: 'L2' }, { ...choice, target: { ...choice.target, packageSha256: 'wrong' } }, { ...choice, filePath: 'word/document.xml' }, { ...choice, view: 'source' }]) {
      assert.equal(client.writeStored('docx-comparison:L1', invalid), false);
      assert.deepEqual(client.readStored('docx-comparison:L1', null), choice);
    }
    client = storage.reopen();
    assert.deepEqual(client.readStored('docx-comparison:L1', null), choice);
    // A malformed stored pin must reach the comparison resolver; it must not become a missing choice and silently select the head.
    const corrupt = { ...choice, target: { ...choice.target, packageSha256: 'corrupt' } };
    storage.stored.set(client.storageKey('docx-comparison:L1'), JSON.stringify(corrupt));
    assert.deepEqual(client.readStored('docx-comparison:L1', null), corrupt);
  } finally { storage.close(); }
});

test('historical Word source loss clears saved comparisons across reopen even after a new head uses another File', () => {
  const storage = storageFixture();
  try {
    let client = storage.reopen();
    client.reconcileAccess({ L1: access('L1'), L2: access('L2'), F1: access('F1'), F2: access('F2') }, 1);
    client.writeStored('revision:L1', { revision: { id: 'L1' }, versions: [{ docx: { sourceFile: { fileId: 'F1' }, projection: 'historical source' } }], accessEpoch: 1 });
    client.writeStored('docx-comparison:L1', selection());
    client.writeStored('docx-comparison:L2', selection('L2'));
    client.writeStored('comment-source:L2:word-two', { body: 'Keep unrelated draft' });
    // A later detail must retain every historical source dependency, including when only its newest version is in this response.
    client.writeStored('revision:L1', { revision: { id: 'L1' }, versions: [{ docx: { sourceFile: { fileId: 'F2' }, projection: 'new head source' } }], accessEpoch: 1 });
    client = storage.reopen();
    client.reconcileAccess({ L1: access('L1'), L2: access('L2'), F1: access('F1'), F2: access('F2') }, 1);
    assert.deepEqual(client.readStored('docx-comparison:L1', null), selection());
    client.retireUnavailableObject('F1');
    assert.equal(client.unavailableObject('L1'), true);
    assert.equal(client.readStored('revision:L1', null), null);
    assert.equal(client.readStored('docx-comparison:L1', null), null);
    assert.equal(storage.stored.has(client.storageKey('docx-comparison:L1')), false);
    assert.equal(client.writeStored('docx-comparison:L1', selection()), false);
    assert.deepEqual(client.readStored('docx-comparison:L2', null), selection('L2'));
    assert.deepEqual(client.readStored('comment-source:L2:word-two', null), { body: 'Keep unrelated draft' });
    assert.deepEqual(client.quarantinedDrafts(), []);
  } finally { storage.close(); }
});

test('Word comparison metadata is retired on revision access loss without becoming a recoverable source draft', () => {
  const storage = storageFixture();
  try {
    const client = storage.reopen(); client.reconcileAccess({ L1: access('L1'), L2: access('L2') }, 1);
    client.writeStored('docx-comparison:L1', selection()); client.writeStored('docx-comparison:L2', selection('L2'));
    client.reconcileAccess({ L2: access('L2') }, 2);
    assert.equal(client.readStored('docx-comparison:L1', null), null);
    assert.equal(storage.stored.has(client.storageKey('docx-comparison:L1')), false);
    assert.deepEqual(client.readStored('docx-comparison:L2', null), selection('L2'));
    assert.deepEqual(client.quarantinedDrafts(), []);
  } finally { storage.close(); }
});

test('protected Word comparisons stay in memory and cannot be read or rewritten after account replacement or lock', () => {
  const storage = storageFixture();
  try {
    const session = activateSession(account('alice')), client = createWorkspaceClient(session);
    assert.equal(client.writeStored('docx-comparison:L1', selection()), true);
    assert.deepEqual(client.readStored('docx-comparison:L1', null), selection());
    assert.equal([...storage.stored.keys()].some(key => key.includes('docx-comparison:')), false);
    const nextSession = activateSession(account('bob')), next = createWorkspaceClient(nextSession);
    assert.equal(client.readStored('docx-comparison:L1', null), null);
    assert.equal(client.writeStored('docx-comparison:L1', selection()), false);
    assert.equal(session.memory.size, 0);
    assert.equal(next.readStored('docx-comparison:L1', null), null);
    next.writeStored('docx-comparison:L1', selection()); lockSession();
    assert.equal(next.readStored('docx-comparison:L1', null), null);
    assert.equal(next.writeStored('docx-comparison:L1', selection()), false);
    assert.equal(nextSession.memory.size, 0);
  } finally { storage.close(); }
});
