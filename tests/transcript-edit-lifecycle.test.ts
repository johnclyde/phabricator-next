import test from 'node:test';
import assert from 'node:assert/strict';
import { canQueue, createWorkspaceClient } from '../client/offline.ts';
import { activateSession, lockSession, SessionChangedError } from '../client/session.ts';
import type { ObjectAccess } from '../shared/policy.ts';

const access = (id: string, edit = true): ObjectAccess => ({ policy: { objectId: id, version: 1, spaceId: 'S1', rules: { view: { kind: 'workspace' }, edit: { kind: 'workspace' }, interact: { kind: 'workspace' } } }, capabilities: { view: true, edit, interact: true, managePolicy: edit }, viewLabel: 'Workspace', editLabel: 'Workspace', interactLabel: 'Workspace' });
const key = 'transcript-edit-draft:L1:version-1', requestKey = 'transcript-edit-request:L1';
const draft = { replacement: 'Keep these exact words 😀\r\n', sourceFile: { fileId: 'F1', sha256: 'a'.repeat(64), bytes: 50 } };
const intent = { id: 'transcript-attempt', body: { replacement: draft.replacement }, draftKey: key, draft, sourceFile: draft.sourceFile };
function fixture(mode: 'local' | 'password' = 'local') {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const entries = new Map<string, string>(); let quota = false;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { get length() { return entries.size; }, key: (index: number) => [...entries.keys()][index] ?? null, getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { if (quota) throw new Error('Quota'); entries.set(key, value); }, removeItem: (key: string) => entries.delete(key) } });
  const session = activateSession({ mode, workspaceId: 'transcript-edit-lifecycle', account: mode === 'password' ? { id: 'U1', username: 'writer', displayName: 'Writer', disabled: false } : null, sessionContext: mode === 'password' ? 'session-one' : null, csrfToken: mode === 'password' ? 'csrf-one' : null, expiresAt: null });
  const client = createWorkspaceClient(session);
  client.reconcileAccess({ L1: access('L1'), F1: access('F1'), F2: access('F2'), R1: access('R1') }, 1, ['S1']);
  return { client, session, entries, failWrites: () => { quota = true; }, allowWrites: () => { quota = false; }, close: () => { lockSession(); if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor); else Reflect.deleteProperty(globalThis, 'localStorage'); } };
}
function locks() {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const pending: { name: string; run: () => void }[] = [];
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: (name: string, action: () => unknown) => new Promise((resolve, reject) => { pending.push({ name, run: () => { try { resolve(action()); } catch (error) { reject(error); } } }); }) } } });
  return { pending, flush: () => { const row = pending.shift(); assert.ok(row, 'a deferred lock request exists'); row.run(); }, close: () => { if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor); else Reflect.deleteProperty(globalThis, 'navigator'); } };
}
test('transcript edits cannot submit from the outbox, including a forged queued request', async () => {
  const f = fixture(), previous = globalThis.fetch; let sent = 0;
  try {
    globalThis.fetch = async () => { sent++; return Response.json({}); };
    assert.equal(canQueue('/api/revisions/L1/transcript-edits', 'POST', intent.body), false);
    await assert.rejects(f.client.request('/api/revisions/L1/transcript-edits', { method: 'POST', body: intent.body, id: intent.id, queued: true }), /explicit online save/);
    assert.equal(sent, 0);
  } finally { globalThis.fetch = previous; f.close(); }
});
test('transcript draft and uncertain request retain exact export bytes on Word source revocation', () => {
  const f = fixture();
  try {
    f.client.writeStored(key, draft); f.client.writeStored(requestKey, intent);
    assert.equal(f.client.savedDraftRecords('transcript-edit-draft:').length, 1);
    f.client.retireUnavailableObject('F1');
    for (const [name, value] of [[key, draft], [requestKey, intent]] as const) {
      assert.equal(f.client.readStored(name, null), null); assert.equal(f.client.draftIsHeld(name), true);
      assert.deepEqual(f.client.quarantinedDrafts().find(item => item.key === name)!.value, value);
    }
    f.client.reconcileAccess({ L1: access('L1'), F1: access('F1') }, 2, ['S1']);
    assert.equal(f.client.draftIsHeld(requestKey), true, 'restored access must not revive uncertain writes');
  } finally { f.close(); }
});
test('transcript drafts also depend on preserved figures and repository source authority', () => {
  for (const dependency of ['F2', 'R1']) {
    const f = fixture();
    try {
      f.session.revisionFiles.set('L1', new Set(['F2'])); f.session.revisionRepositories.set('L1', 'R1');
      f.client.writeStored(key, { replacement: draft.replacement }); f.client.writeStored(requestKey, intent);
      f.client.retireUnavailableObject(dependency);
      assert.equal(f.client.draftIsHeld(key), true); assert.equal(f.client.draftIsHeld(requestKey), true);
    } finally { f.close(); }
  }
});
test('edit permission loss holds transcript proposals without hiding still-viewable source', () => {
  const f = fixture();
  try {
    f.client.writeStored(key, draft); f.client.writeStored(requestKey, intent);
    f.client.reconcileAccess({ L1: access('L1', false), F1: access('F1'), F2: access('F2'), R1: access('R1') }, 2, ['S1']);
    assert.equal(f.client.unavailableObject('L1'), false);
    assert.equal(f.client.draftIsHeld(key), true); assert.equal(f.client.draftIsHeld(requestKey), true);
  } finally { f.close(); }
});
test('quota failure retains both the durable transcript draft and newer unsaved copy for recovery', () => {
  const f = fixture();
  try {
    f.client.writeStored(key, { ...draft, replacement: 'Other view' }); f.failWrites();
    assert.equal(f.client.writeStored(key, draft), false); assert.equal(f.client.draftHasUnsavedMemory(key), true);
    assert.deepEqual(f.client.draftRecords().find(item => item.key === `${key}:unsaved-memory`)!.value, draft);
    f.client.retireUnavailableObject('F1');
    const copies = f.client.quarantinedDrafts().filter(item => item.key === key || item.key === `${key}:unsaved-memory`);
    assert.equal(copies.length, 2); assert.ok(copies.some(item => JSON.stringify(item.value) === JSON.stringify(draft)));
  } finally { f.close(); }
});
test('password-session transcript drafts are memory-only and a late receipt cannot cross logout', async () => {
  const f = fixture('password'), previous = globalThis.fetch; let release!: (response: Response) => void;
  try {
    f.client.writeStored(key, draft); f.client.writeStored(requestKey, intent);
    assert.equal(f.entries.size, 0); assert.equal(f.client.draftRecords().length, 2);
    globalThis.fetch = async () => await new Promise<Response>(resolve => { release = resolve; });
    const pending = f.client.request('/api/revisions/L1/transcript-edits', { method: 'POST', body: intent.body, id: intent.id }, ['F1']);
    lockSession(); release(Response.json({ revision: { id: 'L1' }, accessEpoch: 1 }));
    await assert.rejects(pending, SessionChangedError); assert.equal(f.session.memory.size, 0); assert.equal(f.entries.size, 0);
  } finally { globalThis.fetch = previous; f.close(); }
});

test('competing transcript saves preserve the other durable draft and this tab exact bytes through navigation', async () => {
  const f = fixture(), l = locks(), original = { ...draft, replacement: 'Original durable draft' }, other = { ...draft, replacement: 'Other tab exact bytes\r\n🗣️' };
  try {
    f.client.writeStored(key, original);
    const pending = f.client.retainTranscriptEditDraft(key, draft, original);
    assert.deepEqual(f.client.readStored(key, null), draft, 'new bytes are retained before the lock resolves');
    f.entries.set(f.client.storageKey(key), JSON.stringify(other)); l.flush();
    assert.equal(await pending, 'memory'); assert.deepEqual(JSON.parse(f.entries.get(f.client.storageKey(key))!), other);
    const remounted = createWorkspaceClient(f.session);
    assert.deepEqual(remounted.readStored(key, null), draft); assert.equal(remounted.draftHasUnsavedMemory(key), true);
    const newer = { ...draft, replacement: 'More of this tab’s original proposal.' };
    const changed = remounted.retainTranscriptEditDraft(key, newer, draft); l.flush(); assert.equal(await changed, 'memory');
    assert.deepEqual(JSON.parse(f.entries.get(f.client.storageKey(key))!), other);
    assert.deepEqual(remounted.draftRecords().find(item => item.key === `${key}:unsaved-memory`)!.value, newer);
    remounted.retireUnavailableObject('F1');
    const recovered = remounted.quarantinedDrafts().filter(item => item.key === key || item.key === `${key}:unsaved-memory`);
    assert.equal(recovered.length, 2); assert.ok(recovered.some(item => JSON.stringify(item.value) === JSON.stringify(other))); assert.ok(recovered.some(item => JSON.stringify(item.value) === JSON.stringify(newer)));
  } finally { l.close(); f.close(); }
});

test('a later tab displacement cannot erase a successfully saved transcript editor on remount', async () => {
  const f = fixture(), l = locks();
  try {
    const save = f.client.retainTranscriptEditDraft(key, draft, null); l.flush(); assert.equal(await save, 'saved');
    assert.equal(f.client.draftHasUnsavedMemory(key), false); assert.equal(f.client.draftRecords().length, 0, 'equal recovery shadow is not mislabeled unsaved');
    const other = { ...draft, replacement: 'Another tab saved after us.' }; f.entries.set(f.client.storageKey(key), JSON.stringify(other));
    const remounted = createWorkspaceClient(f.session); assert.deepEqual(remounted.readStored(key, null), draft); assert.equal(remounted.draftHasUnsavedMemory(key), true);
    assert.deepEqual(remounted.savedDraftRecords('transcript-edit-draft:')[0]!.value, draft);
    assert.equal(remounted.removeStoredIfEqual(key, draft), true); assert.deepEqual(JSON.parse(f.entries.get(f.client.storageKey(key))!), other, 'discard only this tab matching copy');
    assert.deepEqual(remounted.readStored(key, null), other);
  } finally { l.close(); f.close(); }
});

test('rapid transcript typing advances its own durable baseline and recovers from quota failure', async () => {
  const f = fixture(), l = locks();
  try {
    const first = f.client.retainTranscriptEditDraft(key, draft, null); l.flush(); assert.equal(await first, 'saved');
    const second = { ...draft, replacement: 'Second exact draft' }, third = { ...draft, replacement: 'Third exact draft' };
    const two = f.client.retainTranscriptEditDraft(key, second, draft), three = f.client.retainTranscriptEditDraft(key, third, second);
    assert.deepEqual(f.client.readStored(key, null), third); l.flush(); await two; l.flush(); assert.equal(await three, 'saved');
    assert.deepEqual(JSON.parse(f.entries.get(f.client.storageKey(key))!), third);
    f.failWrites(); const fourValue = { ...draft, replacement: 'Quota-retained fourth draft' }, four = f.client.retainTranscriptEditDraft(key, fourValue, third); l.flush(); assert.equal(await four, 'memory');
    f.allowWrites(); const remounted = createWorkspaceClient(f.session), fifth = { ...draft, replacement: 'Fifth draft after quota recovery and navigation' };
    const five = remounted.retainTranscriptEditDraft(key, fifth, fourValue); l.flush(); assert.equal(await five, 'saved'); assert.deepEqual(JSON.parse(f.entries.get(f.client.storageKey(key))!), fifth); assert.equal(remounted.draftHasUnsavedMemory(key), false);
  } finally { l.close(); f.close(); }
});

for (const boundary of ['discard', 'receipt', 'source', 'edit', 'session'] as const) test(`a queued transcript draft save cannot resurrect after ${boundary}`, async () => {
  const f = fixture(), l = locks();
  try {
    const pending = f.client.retainTranscriptEditDraft(key, draft, null);
    if (boundary === 'discard') f.client.removeStored(key);
    if (boundary === 'receipt') f.client.removeStoredIfEqual(key, draft);
    if (boundary === 'source') f.client.retireUnavailableObject('F1');
    if (boundary === 'edit') f.client.reconcileAccess({ L1: access('L1', false), F1: access('F1'), F2: access('F2'), R1: access('R1') }, 2, ['S1']);
    if (boundary === 'session') lockSession();
    l.flush(); assert.equal(await pending, 'unavailable'); assert.equal(f.entries.has(f.client.storageKey(key)), false);
    assert.equal(f.client.readStored(key, null), null);
    if (boundary === 'source' || boundary === 'edit') { assert.ok(f.client.quarantinedDrafts().some(item => JSON.stringify(item.value) === JSON.stringify(draft))); f.client.reconcileAccess({ L1: access('L1'), F1: access('F1') }, 3, ['S1']); assert.equal(f.client.readStored(key, null), null); }
    if (boundary === 'session') assert.equal(f.session.memory.size, 0);
  } finally { l.close(); f.close(); }
});

test('transcript draft retention without Web Locks remains recoverable without overwriting durable bytes', async () => {
  const f = fixture(), descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
    const original = { ...draft, replacement: 'Existing durable draft' }; f.client.writeStored(key, original);
    assert.equal(await f.client.retainTranscriptEditDraft(key, draft, original), 'memory'); assert.deepEqual(f.client.readStored(key, null), draft);
    assert.deepEqual(JSON.parse(f.entries.get(f.client.storageKey(key))!), original);
    assert.equal(await f.client.retainTranscriptEditDraft('docx-draft:L1:version-1', draft, null), 'unavailable', 'generic draft families are unchanged');
  } finally { if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor); else Reflect.deleteProperty(globalThis, 'navigator'); f.close(); }
});

test('password transcript draft retention stays in session memory without persistent storage or locks', async () => {
  const f = fixture('password'), l = locks();
  try {
    assert.equal(await f.client.retainTranscriptEditDraft(key, draft, null), 'saved'); assert.equal(l.pending.length, 0); assert.equal(f.entries.size, 0);
    assert.deepEqual(createWorkspaceClient(f.session).readStored(key, null), draft);
    lockSession(); assert.equal(await f.client.retainTranscriptEditDraft(key, { ...draft, replacement: 'Late callback' }, draft), 'unavailable'); assert.equal(f.entries.size, 0); assert.equal(f.session.memory.size, 0);
  } finally { l.close(); f.close(); }
});

for (const [name, lockFamily, original] of [[key, 'transcript-draft', draft], [requestKey, 'file-intent', intent]] as const) test(`transcript cleanup waits for a competing ${lockFamily} write and preserves its new durable copy`, async () => {
  const f = fixture(), l = locks();
  try {
    f.client.writeStored(name, original);
    const changed = { ...original, replacement: 'Another tab’s newly saved work' };
    const lock = f.client.storageKey(`${lockFamily}:${name}`);
    // Another tab already holds/awaits this family’s writer lock. Its successful
    // save must happen before cleanup reads, never between cleanup’s read/delete.
    const competing = navigator.locks.request(lock, () => f.entries.set(f.client.storageKey(name), JSON.stringify(changed)));
    const cleanup = f.client.removeTranscriptEditStoredIfEqual(name, original);
    assert.deepEqual(l.pending.map(item => item.name), [lock, lock]);
    assert.deepEqual(JSON.parse(f.entries.get(f.client.storageKey(name))!), original, 'cleanup does not delete outside the writer lock');
    l.flush(); await competing; l.flush(); assert.equal(await cleanup, false);
    assert.deepEqual(JSON.parse(f.entries.get(f.client.storageKey(name))!), changed);
  } finally { l.close(); f.close(); }
});

test('transcript cleanup retires an older queued save immediately without losing its recovery bytes while waiting', async () => {
  const f = fixture(), l = locks();
  try {
    const save = f.client.retainTranscriptEditDraft(key, draft, null);
    const cleanup = f.client.removeTranscriptEditStoredIfEqual(key, draft);
    assert.deepEqual(f.client.readStored(key, null), draft, 'an interrupted cleanup still has exportable bytes');
    l.flush(); assert.equal(await save, 'unavailable');
    l.flush(); assert.equal(await cleanup, true);
    assert.equal(f.client.readStored(key, null), null); assert.equal(f.entries.has(f.client.storageKey(key)), false);
    assert.equal(f.session.memory.has(`${key}:unsaved-memory`), false);
  } finally { l.close(); f.close(); }
});

test('a newer draft created while cleanup waits keeps its memory and durable baseline, even with equal text', async () => {
  for (const replacement of [draft.replacement, 'New work after cleanup was requested']) {
    const f = fixture(), l = locks();
    try {
      const first = f.client.retainTranscriptEditDraft(key, draft, null); l.flush(); await first;
      const cleanup = f.client.removeTranscriptEditStoredIfEqual(key, draft);
      const next = { ...draft, replacement }, save = f.client.retainTranscriptEditDraft(key, next, draft);
      l.flush(); assert.equal(await cleanup, false);
      assert.deepEqual(f.client.readStored(key, null), next);
      l.flush(); assert.equal(await save, 'saved');
      assert.deepEqual(JSON.parse(f.entries.get(f.client.storageKey(key))!), next);
    } finally { l.close(); f.close(); }
  }
});

for (const boundary of ['view', 'source', 'edit', 'session'] as const) test(`queued transcript cleanup preserves recovery or session retirement after ${boundary} changes`, async () => {
  const f = fixture(), l = locks(); let current = true;
  try {
    f.failWrites(); const save = f.client.retainTranscriptEditDraft(key, draft, null); l.flush(); assert.equal(await save, 'memory');
    const cleanup = f.client.removeTranscriptEditStoredIfEqual(key, draft, () => current);
    if (boundary === 'view') current = false;
    if (boundary === 'source') f.client.retireUnavailableObject('F1');
    if (boundary === 'edit') f.client.reconcileAccess({ L1: access('L1', false), F1: access('F1'), F2: access('F2'), R1: access('R1') }, 2, ['S1']);
    if (boundary === 'session') lockSession();
    l.flush(); assert.equal(await cleanup, false);
    if (boundary === 'view') assert.deepEqual(f.client.readStored(key, null), draft);
    if (boundary === 'source' || boundary === 'edit') assert.ok(f.client.quarantinedDrafts().some(item => JSON.stringify(item.value) === JSON.stringify(draft)));
    if (boundary === 'session') assert.equal(f.session.memory.size, 0);
  } finally { l.close(); f.close(); }
});

test('transcript cleanup without Web Locks removes only memory-only copies and never durable recovery', async () => {
  const f = fixture(), descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
    f.client.writeStored(key, draft);
    assert.equal(await f.client.removeTranscriptEditStoredIfEqual(key, draft), false);
    assert.deepEqual(f.client.readStored(key, null), draft);
    const other = { ...draft, replacement: 'This tab only' };
    assert.equal(await f.client.retainTranscriptEditDraft(key, other, draft), 'memory');
    assert.equal(await f.client.removeTranscriptEditStoredIfEqual(key, other), true);
    assert.deepEqual(f.client.readStored(key, null), draft);
    assert.equal(await f.client.removeTranscriptEditStoredIfEqual('docx-draft:L1:version-1', draft), false);
  } finally { if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor); else Reflect.deleteProperty(globalThis, 'navigator'); f.close(); }
});

test('password transcript cleanup is synchronous in memory and refuses a different exact request', async () => {
  const f = fixture('password'), l = locks();
  try {
    f.client.writeStored(requestKey, intent);
    assert.equal(await f.client.removeTranscriptEditStoredIfEqual(requestKey, { ...intent, id: 'another-operation' }), false);
    assert.deepEqual(f.client.readStored(requestKey, null), intent);
    const cleanup = f.client.removeTranscriptEditStoredIfEqual(requestKey, intent);
    assert.equal(f.client.readStored(requestKey, null), null);
    assert.equal(await cleanup, true); assert.equal(l.pending.length, 0); assert.equal(f.entries.size, 0);
  } finally { l.close(); f.close(); }
});
