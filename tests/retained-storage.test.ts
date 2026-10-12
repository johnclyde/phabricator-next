import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceClient, retainedDraftLockName } from '../client/offline.ts';
import { retainFileIntent } from '../client/file-client.ts';
import { activateSession, lockSession } from '../client/session.ts';
import type { ObjectAccess } from '../shared/policy.ts';

const access = (id: string, edit = true, interact = true): ObjectAccess => ({ policy: { objectId: id, version: 1, spaceId: 'S1', rules: { view: { kind: 'workspace' }, edit: { kind: 'workspace' }, interact: { kind: 'workspace' } } }, capabilities: { view: true, edit, interact, managePolicy: edit }, viewLabel: 'Workspace', editLabel: 'Workspace', interactLabel: 'Workspace' });
const key = 'docx-draft:L1:version-1:replace', requestKey = 'docx-request:L1';
const draft = { replacement: 'Exact local text — café 😀\r\n  ', sourceFile: { fileId: 'F1', sha256: 'a'.repeat(64), bytes: 50 } };
const intent = { id: 'recorded-request', draftKey: key, draft, sourceFile: draft.sourceFile };

/** Separate tabs share physical storage and named locks, but not private drafts. */
function fixture(mode: 'local' | 'password' = 'local') {
  const descriptors = Object.fromEntries(['localStorage', 'navigator'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const entries = new Map<string, string>(), calls: string[] = [], pending: { name: string; run: () => void }[] = [];
  const held = new Set<string>(), afterRelease = new Map<string, (() => void)[]>();
  let quota = false, noLocks = false, rejectLocks = false;
  let readRace: { key: string; writerLock: string; write: () => void } | null = null;
  const storage = {
    get length() { return entries.size; },
    key: (index: number) => [...entries.keys()][index] ?? null,
    getItem: (name: string) => {
      const value = entries.get(name) ?? null;
      if (readRace?.key === name) {
        const race = readRace; readRace = null;
        if (held.has(race.writerLock)) { const jobs = afterRelease.get(race.writerLock) ?? []; jobs.push(race.write); afterRelease.set(race.writerLock, jobs); }
        else race.write();
      }
      return value;
    },
    setItem: (name: string, value: string) => { if (quota) throw new Error('Quota exhausted'); entries.set(name, value); },
    removeItem: (name: string) => entries.delete(name),
  };
  const locks = {
    request: (name: string, commit: () => unknown) => {
      calls.push(name);
      if (rejectLocks) return Promise.reject(new Error('Lock unavailable'));
      return new Promise((resolve, reject) => pending.push({ name, run: () => {
        assert.equal(held.has(name), false, 'the scheduler never admits two writers for a key'); held.add(name);
        const release = () => { held.delete(name); const jobs = afterRelease.get(name) ?? []; afterRelease.delete(name); for (const job of jobs) job(); };
        try { Promise.resolve(commit()).then(value => { release(); resolve(value); }, error => { release(); reject(error); }); }
        catch (error) { release(); reject(error); }
      } }));
    },
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { get locks() { return noLocks ? undefined : locks; } } });
  const session = activateSession({ mode, workspaceId: 'generic-retained-storage', account: mode === 'password' ? { id: 'U1', username: 'writer', displayName: 'Writer', disabled: false } : null, sessionContext: mode === 'password' ? 'context-one' : null, csrfToken: mode === 'password' ? 'csrf-one' : null, expiresAt: null });
  const client = createWorkspaceClient(session);
  client.reconcileAccess(Object.fromEntries(['D1', 'L1', 'T1', 'F1', 'F2', 'R1', 'W1', 'PA1', 'PROJ1'].map(id => [id, access(id)])), 1, ['S1']);
  const flush = () => { const index = pending.findIndex(row => !held.has(row.name)); assert.notEqual(index, -1, 'a writer can acquire its queued lock'); pending.splice(index, 1)[0]!.run(); };
  const settle = async <T,>(promise: Promise<T>): Promise<T> => {
    let done = false; promise.then(() => { done = true; }, () => { done = true; });
    for (let count = 0; !done && count < 100; count++) { if (pending.some(row => !held.has(row.name))) flush(); await new Promise<void>(resolve => setImmediate(resolve)); }
    assert.equal(done, true, 'bounded lock scheduling completed'); return promise;
  };
  return {
    client, session, entries, calls, pending, flush, settle,
    physical: (name: string) => { const value = entries.get(client.storageKey(name)); return value === undefined ? null : JSON.parse(value) as unknown; },
    elsewhere: (name: string, value: unknown) => entries.set(client.storageKey(name), JSON.stringify(value)),
    duringNextRead: (name: string, value: unknown) => {
      const writer = retainedDraftLockName(name); assert.ok(writer);
      readRace = { key: client.storageKey(name), writerLock: client.storageKey(writer), write: () => entries.set(client.storageKey(name), JSON.stringify(value)) };
    },
    failWrites: () => { quota = true; }, allowWrites: () => { quota = false; },
    disableLocks: () => { noLocks = true; }, denyLocks: () => { rejectLocks = true; },
    close: () => { lockSession(); for (const [name, descriptor] of Object.entries(descriptors)) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); } },
  };
}

test('scalar retained families share their writer/cleanup names without absorbing caches or aggregates', () => {
  for (const name of ['task-draft:T1', 'task-comment:T1', 'task-projects:T1', key, requestKey, 'version-draft:D1:version-1', 'revision-lifecycle-draft:D1', 'revision-lifecycle-request:D1', 'revision-author-draft:D1', 'wiki-edit:W1', 'paste-draft:PA1', 'comment-source:L1:version-1:new', 'draft:task:S1']) assert.equal(retainedDraftLockName(name), `file-intent:${name}`, name);
  assert.equal(retainedDraftLockName('transcript-edit-draft:L1:version-1'), 'transcript-draft:transcript-edit-draft:L1:version-1');
  assert.equal(retainedDraftLockName('discussion-choice:L1:version-1'), 'presentation-write:discussion-choice:L1:version-1');
  for (const name of ['outbox', 'state', 'revision:L1', 'file-uploads', 'paper-build-requests:L1']) assert.equal(Boolean(retainedDraftLockName(name)), false, name);
});

for (const name of ['task-draft:T1', 'task-comment:T1', key, 'version-draft:D1:version-1', 'revision-lifecycle-draft:D1', 'wiki-edit:W1', 'paste-draft:PA1', 'comment-source:L1:version-1:new', 'draft:task:S1']) test(`${name} retains the editor’s exact bytes before a durable commit and after another tab displaces them`, async () => {
  const f = fixture(), original = { expectedVersion: 1, body: 'Original', replacement: 'Original' }, next = { expectedVersion: 1, body: 'Later text 😀\r\n', replacement: 'Literal \\cite{source}\r\n  ' };
  try {
    f.elsewhere(name, original);
    const saving = f.client.retainDraft(name, next, original);
    assert.deepEqual(f.client.readStored(name, null), next);
    assert.deepEqual(f.physical(name), original);
    assert.equal(await f.settle(saving), 'saved');
    assert.equal(f.client.draftHasUnsavedMemory(name), false);
    assert.equal(f.client.draftRecords().some(row => row.key === `${name}:unsaved-memory`), false);
    const contender = { ...next, body: 'Other tab’s durable work', replacement: 'Other tab’s durable work' }; f.elsewhere(name, contender);
    const remounted = createWorkspaceClient(f.session);
    assert.deepEqual(remounted.readStored(name, null), next);
    assert.equal(remounted.draftHasUnsavedMemory(name), true);
    assert.deepEqual(remounted.draftRecords().find(row => row.key === `${name}:unsaved-memory`)?.value, next);
    assert.deepEqual(f.physical(name), contender);
  } finally { f.close(); }
});

test('a draft conflict remains private through remount and later typing never overwrites the competing durable copy', async () => {
  const f = fixture(), first = { ...draft, replacement: 'Initial source draft' }, contender = { ...draft, replacement: 'Another tab won the durable slot' };
  try {
    f.elsewhere(key, first);
    const pending = f.client.retainDraft(key, draft, first); f.elsewhere(key, contender);
    assert.equal(await f.settle(pending), 'memory');
    const next = { ...draft, replacement: 'More text belonging to this tab' }, remounted = createWorkspaceClient(f.session);
    assert.equal(await f.settle(remounted.retainDraft(key, next, draft)), 'memory');
    assert.deepEqual(remounted.readStored(key, null), next); assert.deepEqual(f.physical(key), contender);
  } finally { f.close(); }
});

test('rapid writes snapshot caller values and recover their own baseline after quota failure', async () => {
  const f = fixture();
  try {
    assert.equal(await f.settle(f.client.retainDraft(key, draft, null)), 'saved');
    const second = { ...draft, replacement: 'Second' }, third = { ...draft, replacement: 'Third 😀' };
    const writingSecond = f.client.retainDraft(key, second, draft), writingThird = f.client.retainDraft(key, third, second);
    third.replacement = 'Caller mutation after scheduling';
    await f.settle(writingSecond); assert.equal(await f.settle(writingThird), 'saved');
    const capturedThird = { ...third, replacement: 'Third 😀' }; assert.deepEqual(f.physical(key), capturedThird);
    f.failWrites(); const fourth = { ...draft, replacement: 'Exportable during quota failure' };
    assert.equal(await f.settle(f.client.retainDraft(key, fourth, capturedThird)), 'memory');
    f.allowWrites(); const fifth = { ...draft, replacement: 'Continued after capacity was restored' };
    assert.equal(await f.settle(createWorkspaceClient(f.session).retainDraft(key, fifth, fourth)), 'saved');
    assert.deepEqual(f.physical(key), fifth);
  } finally { f.close(); }
});

for (const name of [key, requestKey]) test(`cleanup and ${name} writers serialize a contender at the exact read/delete boundary`, async () => {
  const f = fixture(), original = name === key ? draft : intent, contender = { ...original, id: 'a-newer-retained-copy' };
  try {
    f.elsewhere(name, original);
    const cleanup = f.client.removeRetainedDraftIfEqual(name, original);
    assert.equal(f.pending.length, 1); assert.equal(f.pending[0]!.name, f.client.storageKey(retainedDraftLockName(name)!));
    // A second tab tries to write as cleanup reads the physical value. The lock
    // scheduler defers that write to release; without that lock it lands between
    // the read and delete and is lost.
    f.duringNextRead(name, contender);
    assert.equal(await f.settle(cleanup), true);
    assert.deepEqual(f.physical(name), contender);
  } finally { f.close(); }
});

test('request cleanup uses retainFileIntent’s actual writer lock and preserves a newly reserved request', async () => {
  const f = fixture(), next = { ...intent, id: 'new-explicit-operation' };
  try {
    const retained = retainFileIntent(f.client, requestKey, next);
    const cleanup = f.client.removeRetainedDraftIfEqual(requestKey, intent);
    assert.deepEqual(f.pending.map(item => item.name), [f.client.storageKey(`file-intent:${requestKey}`), f.client.storageKey(`file-intent:${requestKey}`)]);
    assert.equal((await f.settle(retained)).accepted, true);
    assert.equal(await f.settle(cleanup), false);
    assert.deepEqual(f.client.readStored(requestKey, null), next);
  } finally { f.close(); }
});

test('an immutable request snapshots nested caller bytes before waiting for its writer lock', async () => {
  const f = fixture(), original = structuredClone(intent), caller = structuredClone(intent);
  try {
    const reserving = retainFileIntent(f.client, requestKey, caller);
    assert.equal(f.pending.length, 1, 'the reservation is waiting behind its writer lock');
    caller.id = 'changed-after-reserving';
    caller.draft.replacement = 'A later caller edit must not alter the reserved request';
    caller.sourceFile.sha256 = 'b'.repeat(64);
    const result = await f.settle(reserving);
    assert.equal(result.accepted, true); assert.equal(result.persisted, true);
    assert.deepEqual(result.intent, original);
    assert.deepEqual(f.physical(requestKey), original);
    assert.deepEqual(f.client.readStored(requestKey, null), original);
  } finally { f.close(); }
});

test('cleanup retires queued old writes before awaiting storage, while equal-text new work survives', async () => {
  const f = fixture();
  try {
    const old = f.client.retainDraft(key, draft, null), cleanup = f.client.removeRetainedDraftIfEqual(key, draft);
    assert.deepEqual(f.client.readStored(key, null), draft, 'retired cleanup can still export the unsaved bytes');
    assert.equal(await f.settle(old), 'unavailable'); assert.equal(await f.settle(cleanup), true);
    assert.equal(f.physical(key), null); assert.equal(f.client.readStored(key, null), null);
    assert.equal(await f.settle(f.client.retainDraft(key, draft, null)), 'saved');
    const deleting = f.client.removeRetainedDraftIfEqual(key, draft), renewed = f.client.retainDraft(key, { ...draft }, draft);
    assert.equal(await f.settle(deleting), false); assert.equal(await f.settle(renewed), 'saved');
    assert.deepEqual(f.physical(key), draft);
  } finally { f.close(); }
});

for (const sameMount of [false, true]) test(`acknowledged cleanup permits a fresh draft ${sameMount ? 'from the mounted editor’s prior baseline' : 'after a fresh empty baseline'} without reviving submitted text`, async () => {
  const f = fixture(), first = { body: 'The submitted comment' }, next = { body: 'A later comment — café 😀\r\n  ' }, name = 'task-comment:T1';
  try {
    assert.equal(await f.settle(f.client.retainDraft(name, first, null)), 'saved');
    assert.equal(await f.settle(f.client.removeRetainedDraftIfEqual(name, first)), true);
    assert.equal(f.client.readStored(name, null), null);
    assert.equal(f.client.draftRecords().some(row => row.key === name || row.key === `${name}:unsaved-memory`), false);
    assert.equal(await f.settle(f.client.retainDraft(name, next, sameMount ? first : null)), 'saved');
    assert.deepEqual(f.physical(name), next);
    assert.deepEqual(createWorkspaceClient(f.session).readStored(name, null), next);
    assert.equal(f.client.draftHasUnsavedMemory(name), false);
    assert.equal(await f.settle(f.client.removeRetainedDraftIfEqual(name, first)), false);
    assert.deepEqual(f.physical(name), next);
  } finally { f.close(); }
});

test('a fresh post-cleanup draft stays exportable when another tab claims the empty durable slot first', async () => {
  const f = fixture(), first = { body: 'Submitted' }, next = { body: 'New work in the same mounted editor' }, contender = { body: 'A different tab started another draft' }, name = 'task-comment:T1';
  try {
    assert.equal(await f.settle(f.client.retainDraft(name, first, null)), 'saved');
    assert.equal(await f.settle(f.client.removeRetainedDraftIfEqual(name, first)), true);
    f.elsewhere(name, contender);
    assert.equal(await f.settle(f.client.retainDraft(name, next, first)), 'memory');
    assert.deepEqual(f.physical(name), contender);
    assert.deepEqual(createWorkspaceClient(f.session).readStored(name, null), next);
    assert.equal(f.client.draftHasUnsavedMemory(name), true);
  } finally { f.close(); }
});

test('another tab deleting a saved draft does not grant this mounted editor a new empty baseline', async () => {
  const f = fixture(), first = { body: 'Draft visible in both tabs' }, next = { body: 'Still being edited here' }, name = 'task-comment:T1';
  try {
    assert.equal(await f.settle(f.client.retainDraft(name, first, null)), 'saved');
    f.entries.delete(f.client.storageKey(name));
    assert.equal(await f.settle(f.client.retainDraft(name, next, first)), 'memory');
    assert.equal(f.physical(name), null);
    assert.deepEqual(createWorkspaceClient(f.session).readStored(name, null), next);
    assert.equal(f.client.draftHasUnsavedMemory(name), true);
  } finally { f.close(); }
});

for (const operation of ['write', 'cleanup'] as const) for (const boundary of ['view', 'file', 'repository', 'edit', 'session'] as const) test(`${operation} cannot commit after its ${boundary} boundary retires`, async () => {
  const f = fixture(); let current = true;
  try {
    f.session.revisionRepositories.set('L1', 'R1'); f.session.revisionFiles.set('L1', new Set(['F1']));
    const original = { ...draft, replacement: 'Old durable copy' }; f.elsewhere(key, original);
    if (operation === 'cleanup') { f.failWrites(); assert.equal(await f.settle(f.client.retainDraft(key, draft, original)), 'memory'); f.allowWrites(); }
    const pending = operation === 'write' ? f.client.retainDraft(key, draft, original, () => current) : f.client.removeRetainedDraftIfEqual(key, draft, () => current);
    if (boundary === 'view') current = false;
    if (boundary === 'file') f.client.retireUnavailableObject('F1');
    if (boundary === 'repository') f.client.retireUnavailableObject('R1');
    if (boundary === 'edit') f.client.reconcileAccess({ L1: access('L1', false), F1: access('F1'), R1: access('R1') }, 2, ['S1']);
    if (boundary === 'session') lockSession();
    const result = await f.settle<boolean | string>(pending); assert.equal(result === 'saved' || result === true, false);
    if (boundary === 'view') { assert.deepEqual(f.physical(key), original); assert.deepEqual(f.client.readStored(key, null), draft); }
    else if (boundary === 'session') { assert.equal(f.session.memory.size, 0); assert.deepEqual(f.physical(key), original); }
    else { assert.equal(f.client.readStored(key, null), null); assert.ok(f.client.quarantinedDrafts().some(row => JSON.stringify(row.value) === JSON.stringify(draft))); }
  } finally { f.close(); }
});

for (const denied of [false, true]) test(`${denied ? 'rejected' : 'missing'} Web Locks never permits unsafe durable draft mutation`, async () => {
  const f = fixture();
  try {
    if (denied) f.denyLocks(); else f.disableLocks();
    const original = { ...draft, replacement: 'Existing durable proposal' }; f.elsewhere(key, original);
    assert.equal(await f.client.retainDraft(key, draft, original), 'memory');
    assert.deepEqual(f.client.readStored(key, null), draft); assert.deepEqual(f.physical(key), original);
    assert.equal(await f.client.removeRetainedDraftIfEqual(key, original), false);
    assert.deepEqual(f.physical(key), original); assert.deepEqual(f.client.readStored(key, null), draft);
  } finally { f.close(); }
});

test('normal cleanup cannot bypass a held draft, while password lifetime stays synchronous and private', async () => {
  const f = fixture('password');
  try {
    assert.equal(await f.client.retainDraft(key, draft, null), 'saved'); assert.equal(f.pending.length, 0); assert.equal(f.entries.size, 0);
    f.client.reconcileAccess({ L1: access('L1', false), F1: access('F1') }, 2, ['S1']);
    assert.equal(await f.client.removeRetainedDraftIfEqual(key, draft), false); assert.ok(f.client.quarantinedDrafts().some(row => JSON.stringify(row.value) === JSON.stringify(draft)));
    lockSession(); assert.equal(await f.client.retainDraft(key, draft, null), 'unavailable'); assert.equal(await f.client.removeRetainedDraftIfEqual(key, draft), false);
    assert.equal(f.session.memory.size, 0); assert.equal(f.entries.size, 0);
  } finally { f.close(); }
});
