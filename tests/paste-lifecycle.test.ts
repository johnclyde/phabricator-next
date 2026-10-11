import test from 'node:test';
import assert from 'node:assert/strict';
import { canQueue, createWorkspaceClient } from '../client/offline.ts';
import { activateSession, lockSession, SessionChangedError } from '../client/session.ts';
import type { ObjectAccess } from '../shared/policy.ts';

const access = (id: string, edit = true, interact = true): ObjectAccess => ({ policy: { objectId: id, version: 1, spaceId: 'S1', rules: { view: { kind: 'workspace' }, edit: { kind: 'workspace' }, interact: { kind: 'workspace' } } }, capabilities: { view: true, edit, interact, managePolicy: edit }, viewLabel: 'Workspace', editLabel: 'Workspace', interactLabel: 'Workspace' });
const source = { pasteId: 'PA1', number: 1, content: '\ufeffPrivate source\r\n', sha256: 'a'.repeat(64), bytes: 19, lineCount: 2 };
const draft = { title: 'Unsent title', language: 'typescript', content: 'Keep this exact draft\r\n' };
const commentDraft = { contentVersion: 1, contentHash: source.sha256, body: 'Read version one' };
const commentIntent = { id: 'exact-comment', kind: 'comment', path: '/api/pastes/PA1/comments', method: 'POST' as const, body: { contentVersion: 1, body: commentDraft.body }, draftKey: 'paste-comment:PA1:1', draft: commentDraft };
function fixture(mode: 'local' | 'password' = 'local', verify = true) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'), entries = new Map<string, string>(); let quota = false;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { get length() { return entries.size; }, key: (index: number) => [...entries.keys()][index] ?? null, getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { if (quota) throw new Error('Quota'); entries.set(key, value); }, removeItem: (key: string) => entries.delete(key) } });
  const client = createWorkspaceClient(activateSession({ mode, workspaceId: 'paste-lifecycle', account: mode === 'password' ? { id: 'U1', username: 'reviewer', displayName: 'Reviewer', disabled: false } : null, sessionContext: mode === 'password' ? 'session-one' : null, csrfToken: mode === 'password' ? 'csrf-one' : null, expiresAt: null }));
  if (verify) client.reconcileAccess({ PA1: access('PA1') }, 1, ['S1', 'S2']);
  return { client, entries, failWrites: () => { quota = true; }, close: () => { lockSession(); if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor); else Reflect.deleteProperty(globalThis, 'localStorage'); } };
}

test('Paste creation, edits and comments never enter automatic offline replay', async () => {
  const current = fixture(), previous = globalThis.fetch; let requests = 0;
  try {
    globalThis.fetch = async () => { requests++; return Response.json({}); };
    for (const operation of [{ path: '/api/pastes', method: 'POST' as const, body: { content: draft.content } }, { path: '/api/pastes/PA1', method: 'PATCH' as const, body: { expectedVersion: 1, content: draft.content } }, { path: commentIntent.path, method: commentIntent.method, body: commentIntent.body }]) {
      assert.equal(canQueue(operation.path, operation.method, operation.body), false);
      await assert.rejects(current.client.request(operation.path, { ...operation, id: 'no-auto', queued: true }), /requires an explicit online save/);
    }
    assert.equal(requests, 0);
  } finally { globalThis.fetch = previous; current.close(); }
});

test('Paste source reads verify current workspace authority before fetching content', async () => {
  const current = fixture('local', false), previous = globalThis.fetch, calls: string[] = []; let release!: (response: Response) => void;
  try {
    globalThis.fetch = async url => { calls.push(String(url)); return String(url).endsWith('/state') ? await new Promise<Response>(resolve => { release = resolve; }) : Response.json({ version: source, accessEpoch: 1 }); };
    const pending = current.client.request('/api/pastes/PA1/versions/1');
    assert.equal(calls.length, 1); assert.ok(calls[0]!.endsWith('/api/state'));
    release(Response.json({ access: { PA1: access('PA1') }, spaces: [{ id: 'S1' }], accessEpoch: 1 }));
    assert.deepEqual(await pending, { version: source, accessEpoch: 1 }); assert.equal(calls.length, 2);
  } finally { globalThis.fetch = previous; current.close(); }
});

test('interact-only Paste comments retain exact requests, while later interact loss holds them without requiring edit', async () => {
  const current = fixture(), previous = globalThis.fetch; let requests = 0;
  try {
    const { client } = current; client.reconcileAccess({ PA1: access('PA1', false, true) }, 2, ['S1']);
    assert.equal(client.writeStored(commentIntent.draftKey, commentDraft), true); assert.equal(client.writeStored('paste-request:PA1', commentIntent), true);
    client.reconcileAccess({ PA1: access('PA1', false, true) }, 3, ['S1']);
    assert.deepEqual(client.readStored('paste-request:PA1', null), commentIntent); assert.deepEqual(client.readStored(commentIntent.draftKey, null), commentDraft); assert.equal(client.draftIsHeld('paste-request:PA1'), false);
    globalThis.fetch = async (_url, options) => { requests++; assert.deepEqual(JSON.parse(String(options?.body)), commentIntent.body); return Response.json({ kind: 'comment', contentVersion: 1, accessEpoch: 3 }); };
    await client.request(commentIntent.path, { method: 'POST', body: commentIntent.body, id: commentIntent.id }); assert.equal(requests, 1);
    client.reconcileAccess({ PA1: access('PA1', true, false) }, 4, ['S1']);
    assert.equal(client.unavailableObject('PA1'), false); assert.equal(client.draftIsHeld(commentIntent.draftKey), true); assert.equal(client.draftIsHeld('paste-request:PA1'), true);
    assert.deepEqual(client.quarantinedDrafts().find(item => item.key === 'paste-request:PA1')!.value, commentIntent);
    await assert.rejects(client.request(commentIntent.path, { method: 'POST', body: commentIntent.body, id: commentIntent.id }), /Permission to submit/); assert.equal(requests, 1);
  } finally { globalThis.fetch = previous; current.close(); }
});

test('revoked creation Space quarantines exact Paste source and request and does not revive them on restored access', () => {
  const current = fixture();
  try {
    const { client } = current; const key = 'paste-create:S2', intent = { id: 'exact-create', kind: 'create', path: '/api/pastes', method: 'POST', body: { ...draft, access: { spaceId: 'S2' } }, draftKey: key, draft };
    client.writeStored(key, draft); client.writeStored(`${key}:request`, intent); client.reconcileAccess({ PA1: access('PA1') }, 2, ['S1']);
    for (const saved of [key, `${key}:request`]) { assert.equal(client.readStored(saved, null), null); assert.equal(client.draftIsHeld(saved), true); }
    assert.deepEqual(client.quarantinedDrafts().find(item => item.key === key)!.value, draft); assert.deepEqual(client.quarantinedDrafts().find(item => item.key === `${key}:request`)!.value, intent);
    client.reconcileAccess({ PA1: access('PA1') }, 3, ['S1', 'S2']); assert.equal(client.readStored(key, null), null); assert.equal(client.draftIsHeld(`${key}:request`), true);
  } finally { current.close(); }
});

test('Paste source and list snapshots reject stale epochs and late source responses after view loss', async () => {
  const current = fixture(), previous = globalThis.fetch; let release!: (response: Response) => void;
  try {
    const { client } = current, keys = ['paste:PA1', 'paste-version:PA1:1', 'paste-history:PA1', 'paste-list:status=active'];
    for (const key of keys) client.writeStored(key, { version: source, accessEpoch: 1 });
    client.writeStored('paste-draft:PA1:1:1', draft);
    client.reconcileAccess({ PA1: access('PA1') }, 2, ['S1']);
    for (const key of keys) { assert.equal(client.readStored(key, null), null); assert.equal(client.writeStored(key, { version: source, accessEpoch: 1 }), false); }
    assert.deepEqual(client.readStored('paste-draft:PA1:1:1', null), draft, 'an unrelated policy epoch never discards the local edit');
    let signal: AbortSignal | null | undefined;
    globalThis.fetch = async (_url, options) => { signal = options?.signal; return await new Promise<Response>(resolve => { release = resolve; }); };
    const pending = client.request('/api/pastes/PA1/versions/1'); client.reconcileAccess({}, 3, ['S1']); assert.equal(signal?.aborted, true);
    client.reconcileAccess({ PA1: access('PA1') }, 4, ['S1']); release(Response.json({ version: source, accessEpoch: 2 })); await assert.rejects(pending, /unavailable|access|visibility/i);
    assert.equal(client.readStored('paste-version:PA1:1', null), null); assert.equal(client.draftIsHeld('paste-draft:PA1:1:1'), true);
  } finally { globalThis.fetch = previous; current.close(); }
});

test('quota-retained Paste draft and a different durable copy both survive revocation for export', () => {
  const current = fixture();
  try {
    const { client } = current, key = 'paste-draft:PA1:1:1', other = { ...draft, content: 'Other tab source' };
    client.writeStored(key, other); current.failWrites(); assert.equal(client.writeStored(key, draft), false); assert.deepEqual(client.readStored(key, null), draft);
    client.reconcileAccess({}, 2, ['S1']);
    const copies = client.quarantinedDrafts().filter(item => item.key === key || item.key === `${key}:unsaved-memory`).map(item => item.value);
    assert.equal(copies.length, 2); assert.ok(copies.some(item => JSON.stringify(item) === JSON.stringify(other))); assert.ok(copies.some(item => JSON.stringify(item) === JSON.stringify(draft))); assert.ok(client.quarantineWarning()); assert.equal(client.readStored(key, null), null);
  } finally { current.close(); }
});

test('protected Paste requests stay in session memory and late receipts cannot cross accounts', async () => {
  const current = fixture('password'), previous = globalThis.fetch; let release!: (response: Response) => void;
  try {
    const { client } = current; client.writeStored(commentIntent.draftKey, commentDraft); client.writeStored('paste-request:PA1', commentIntent); assert.equal(current.entries.size, 0);
    globalThis.fetch = async () => await new Promise<Response>(resolve => { release = resolve; });
    const pending = client.request(commentIntent.path, { method: 'POST', body: commentIntent.body, id: commentIntent.id });
    const next = createWorkspaceClient(activateSession({ mode: 'password', workspaceId: 'paste-lifecycle', account: { id: 'U2', username: 'other', displayName: 'Other', disabled: false }, sessionContext: 'session-two', csrfToken: 'csrf-two', expiresAt: null }));
    release(Response.json({ kind: 'comment', contentVersion: 1, accessEpoch: 1 })); await assert.rejects(pending, SessionChangedError);
    assert.equal(next.readStored('paste-request:PA1', null), null); assert.equal(next.readStored(commentIntent.draftKey, null), null); assert.equal(client.writeStored(commentIntent.draftKey, commentDraft), false); assert.equal(current.entries.size, 0);
  } finally { globalThis.fetch = previous; current.close(); }
});
