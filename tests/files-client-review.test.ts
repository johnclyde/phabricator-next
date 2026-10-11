import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceClient } from '../client/offline.ts';
import { fileBytes, retainFileIntent, type UploadIntent } from '../client/file-client.ts';
import { activateSession, lockSession } from '../client/session.ts';
import type { ObjectAccess } from '../shared/policy.ts';

const access = (objectId: string): ObjectAccess => ({ policy: { objectId, version: 1, spaceId: 'S1', rules: { view: { kind: 'workspace' }, edit: { kind: 'workspace' }, interact: { kind: 'workspace' } } }, capabilities: { view: true, edit: true, interact: true, managePolicy: true }, viewLabel: 'Workspace', editLabel: 'Workspace', interactLabel: 'Workspace' });
const snapshot = { revision: { id: 'P1', repositoryId: null }, versions: [{ id: 'version-one', number: 1, assets: [{ fileId: 'F1' }], files: [{ path: 'main.tex', content: 'Previously authorized source' }] }] };
function local() {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'), entries = new Map<string, string>(); let quota = false;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { get length() { return entries.size; }, key: (index: number) => [...entries.keys()].sort((a, b) => a.includes('revision-source:') ? 1 : b.includes('revision-source:') ? -1 : a < b ? -1 : 1)[index] ?? null, getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { if (quota) throw new Error('Quota'); entries.set(key, value); }, removeItem: (key: string) => entries.delete(key) } });
  const value = createWorkspaceClient(activateSession({ mode: 'local', workspaceId: 'files-review', account: null, sessionContext: null, csrfToken: null, expiresAt: null }));
  value.reconcileAccess({ F1: access('F1'), P1: access('P1') }, 1);
  return { value, entries, failWrites: () => { quota = true; }, close: () => { lockSession(); if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor); else Reflect.deleteProperty(globalThis, 'localStorage'); } };
}

test('known binary access denial retires historical source even if a follow-up metadata read loses the network', async () => {
  const fixture = local(), previous = globalThis.fetch; const { value } = fixture;
  try {
    value.writeStored('revision:P1', snapshot);
    value.writeStored('version-draft:P1:1', { files: snapshot.versions[0].files, assets: [{ fileId: 'F1' }], message: 'Preserve as export only' });
    globalThis.fetch = async path => { if (String(path).endsWith('/data')) return Response.json({ error: 'Object was not found.', code: 'OBJECT_UNAVAILABLE' }, { status: 404 }); throw new TypeError('The network disappeared after the denial'); };
    await assert.rejects(fileBytes(value, { id: 'F1', bytes: 1, sha256: 'a'.repeat(64) }, new AbortController().signal));
    assert.equal(value.unavailableObject('F1'), true); assert.equal(value.unavailableObject('P1'), true);
    assert.equal(value.readStored('revision:P1', null), null);
    assert.ok(value.quarantinedDrafts().some(item => item.key === 'version-draft:P1:1'));
  } finally { globalThis.fetch = previous; fixture.close(); }
});

test('a stale cross-tab dependency index cannot erase File identities already learned from cached historical versions', async () => {
  const fixture = local(), previous = globalThis.fetch; const { value } = fixture;
  try {
    value.writeStored('revision:P1', snapshot);
    // Another tab with an older /state snapshot has no figure identities. Storage
    // key enumeration order is unspecified, so exercise the stale index last.
    fixture.entries.set(value.storageKey('revision-source:P1'), JSON.stringify({ repositoryId: null, fileIds: [] }));
    globalThis.fetch = async () => Response.json({ error: 'Object was not found.', code: 'OBJECT_UNAVAILABLE' }, { status: 404 });
    await assert.rejects(value.request('/api/files/F1'));
    assert.equal(value.unavailableObject('F1'), true); assert.equal(value.unavailableObject('P1'), true);
    assert.equal(value.readStored('revision:P1', null), null);
  } finally { globalThis.fetch = previous; fixture.close(); }
});

test('quota-failed upload recovery metadata survives component remount through session memory without file bytes', () => {
  const fixture = local(), { value } = fixture;
  try {
    const intent: UploadIntent = { id: 'f657dedd-908b-46f9-8d42-e58f9dfe0a16', name: 'figure.png', altText: 'Recover this upload', sha256: 'a'.repeat(64), bytes: 42, createdAt: '2026-10-10' };
    fixture.failWrites(); assert.equal(value.writeStored('file-uploads', [intent]), false);
    assert.deepEqual(value.readStored('file-uploads', []), [intent]);
    assert.ok(value.draftRecords().some(item => JSON.stringify(item.value).includes(intent.id)));
    assert.equal([...value.session!.memory.values()].some(json => json.includes('dataBase64')), false);
  } finally { fixture.close(); }
});

test('concurrent submitted intents share a lock and preserve the earlier exact request across tabs', async () => {
  const fixture = local(), { value } = fixture, descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const lockNames: string[] = []; let queue = Promise.resolve();
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: <T,>(name: string, callback: () => T) => { lockNames.push(name); const work = queue.then(callback); queue = work.then(() => undefined, () => undefined); return work; } } } });
  try {
    const key = 'version-draft:P1:1:submitted-assets';
    const a = { id: 'original-save', body: { files: ['Original text'], assets: ['F1'] } }, b = { id: 'other-save', body: { files: ['Different text'], assets: [] } };
    const [original, conflicting] = await Promise.all([retainFileIntent(value, key, a), retainFileIntent(value, key, b)]);
    assert.deepEqual(original, { intent: a, accepted: true, persisted: true });
    assert.deepEqual(conflicting, { intent: a, accepted: false, persisted: true });
    assert.deepEqual(value.readStored(key, null), a); assert.equal(lockNames.length, 2); assert.equal(lockNames[0], lockNames[1]);
    assert.equal((await retainFileIntent(value, key, a)).accepted, true, 'an exact explicit retry keeps its identity');
    value.removeStoredIfEqual(key, b); assert.deepEqual(value.readStored(key, null), a, 'another tab cannot clear an unmatched pending intent');
    value.removeStoredIfEqual(key, a); assert.equal((await retainFileIntent(value, key, b)).accepted, true);
  } finally { fixture.close(); if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor); else Reflect.deleteProperty(globalThis, 'navigator'); }
});

test('submitted intent conflict checks both a quota-retained memory copy and a different durable copy', async () => {
  const fixture = local(), { value } = fixture, descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: async <T,>(_name: string, callback: () => T) => callback() } } });
  try {
    const key = 'file-draft:F1:request'; const memory = { id: 'memory-save', body: { name: 'Unsaved memory name' } }, durable = { id: 'durable-save', body: { name: 'Another tab name' } };
    fixture.failWrites(); assert.equal((await retainFileIntent(value, key, memory)).persisted, false);
    fixture.entries.set(value.storageKey(key), JSON.stringify(durable));
    const result = await retainFileIntent(value, key, memory); assert.equal(result.accepted, false); assert.deepEqual(result.intent, durable);
    assert.deepEqual(value.readStored(key, null), memory); assert.equal(fixture.entries.get(value.storageKey(key)), JSON.stringify(durable));
    value.removeStoredIfEqual(key, memory); assert.deepEqual(value.readStored(key, null), durable);
  } finally { fixture.close(); if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor); else Reflect.deleteProperty(globalThis, 'navigator'); }
});
