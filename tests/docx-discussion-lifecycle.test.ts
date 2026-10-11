import test from 'node:test';
import assert from 'node:assert/strict';
import { canQueue, createWorkspaceClient, RequestError, type PendingMutation } from '../client/offline.ts';
import { activateSession, lockSession, SessionChangedError } from '../client/session.ts';
import type { ObjectAccess } from '../shared/policy.ts';
import type { RevisionDetail, RevisionVersion } from '../shared/types.ts';

const time = '2026-10-11T12:00:00Z', path = '/api/revisions/L1/docx/export-discussion';
const input = { versionId: 'word-v1', contentHash: 'a'.repeat(64), expectedAccessEpoch: 1, threads: [{ threadId: 'thread-1', expectedThreadVersion: 2 }] };
const passage = { rangeId: 'original-range', start: 0, end: 7, quote: 'Private' };
const comment = { body: 'Preserve this exact unsaved thought 😀\r\n', versionId: input.versionId, docxPassage: passage };
const draftKey = 'comment-source:L1:word-v1';
const access = (id: string, interact = true, edit = false): ObjectAccess => ({ policy: { objectId: id, version: 1, spaceId: 'S1', rules: { view: { kind: 'workspace' }, edit: { kind: 'workspace' }, interact: { kind: 'workspace' } } }, capabilities: { view: true, edit, interact, managePolicy: edit }, viewLabel: 'Workspace', editLabel: 'Workspace', interactLabel: 'Workspace' });
const version: RevisionVersion = { id: input.versionId, revisionId: 'L1', number: 1, files: [], contentHash: input.contentHash, message: 'Imported', createdAt: time, docx: { format: 'docx', fileName: 'private.docx', sha256: 'b'.repeat(64), bytes: 100, sourceFile: { fileId: 'F1', sha256: 'b'.repeat(64), bytes: 100 }, projection: { format: 'phabricator.docx.projection.v1', mainPart: 'word/document.xml', blocks: [], notes: [], comments: [], changes: [], editableRanges: [], warnings: [] } } };
const detail: RevisionDetail = { revision: { id: 'L1', kind: 'document', title: 'Private Word document', summary: '', status: 'needs_review', repositoryId: null, projectId: null, currentVersion: 1, createdAt: time, updatedAt: time }, versions: [version], comments: [], threads: [], threadEvents: [], suggestionApplications: [], reviews: [], activity: [], accessEpoch: 1 };
const queued: PendingMutation = { id: 'original-comment-request', path: '/api/revisions/L1/comments', method: 'POST', body: comment, label: 'Comment added', createdAt: time };
function fixture(mode: 'local' | 'password' = 'local', interact = true) {
  const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'), win = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const entries = new Map<string, string>(), events = new EventTarget(); let quota = false;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { get length() { return entries.size; }, key: (index: number) => [...entries.keys()][index] ?? null, getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { if (quota) throw new Error('Quota'); entries.set(key, value); }, removeItem: (key: string) => entries.delete(key) } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: events });
  const client = createWorkspaceClient(activateSession({ mode, workspaceId: 'word-discussion', account: mode === 'password' ? { id: 'U1', username: 'reader', displayName: 'Reader', disabled: false } : null, sessionContext: mode === 'password' ? 'first-context' : null, csrfToken: mode === 'password' ? 'first-csrf' : null, expiresAt: null }));
  client.reconcileAccess({ L1: access('L1', interact), F1: access('F1') }, 1, ['S1']); client.writeStored('revision:L1', detail);
  return { client, entries, failWrites() { quota = true; }, removeElsewhere() { const key = client.storageKey('revision:L1'), oldValue = entries.get(key) ?? null; entries.delete(key); const event = new Event('storage'); Object.assign(event, { key, oldValue, newValue: null }); events.dispatchEvent(event); }, close() { lockSession(); if (storage) Object.defineProperty(globalThis, 'localStorage', storage); else Reflect.deleteProperty(globalThis, 'localStorage'); if (win) Object.defineProperty(globalThis, 'window', win); else Reflect.deleteProperty(globalThis, 'window'); } };
}

test('read-only password viewers can explicitly export discussion with CSRF but never enqueue an export', async () => {
  const current = fixture('password', false), previous = globalThis.fetch; const requests: RequestInit[] = [];
  try {
    globalThis.fetch = async (_url, init) => { requests.push(init!); return Response.json({ accessEpoch: 1, dataBase64: 'PRIVATE_EXPORT' }); };
    assert.deepEqual(await current.client.request(path, { method: 'POST', body: input }, ['F1']), { accessEpoch: 1, dataBase64: 'PRIVATE_EXPORT' });
    assert.equal(requests.length, 1); assert.equal(new Headers(requests[0]!.headers).get('X-CSRF-Token'), 'first-csrf'); assert.deepEqual(JSON.parse(String(requests[0]!.body)), input);
    assert.equal(current.entries.size, 0, 'password workspace never persists prepared bytes');
    assert.equal(canQueue(path, 'POST', input), false);
    await assert.rejects(current.client.request(path, { method: 'POST', body: input, queued: true, id: 'never-queued' }), /explicit online save/);
    await assert.rejects(current.client.request('/api/revisions/L1/docx/replace', { method: 'POST', body: {} }), /Permission/);
    assert.equal(requests.length, 1);
  } finally { globalThis.fetch = previous; current.close(); }
});

test('local Word discussion drafts and queued comments preserve original anchors through source revocation and quota twins', async () => {
  const current = fixture(), previous = globalThis.fetch; let calls = 0;
  try {
    const { client } = current;
    client.writeStored(draftKey, { ...comment, body: 'Earlier other-tab thought' }); client.writeStored('outbox', [queued]);
    current.failWrites(); assert.equal(client.writeStored(draftKey, comment), false);
    assert.equal(canQueue(queued.path, queued.method, queued.body), true);
    globalThis.fetch = async () => { calls++; return Response.json({}); };
    client.retireUnavailableObject('F1');
    assert.equal(client.unavailableObject('L1'), true); assert.equal(client.readStored('revision:L1', null), null); assert.deepEqual(client.readStored('outbox', []), []);
    const copies = client.quarantinedDrafts().filter(item => item.key === draftKey || item.key === `${draftKey}:unsaved-memory`);
    assert.equal(copies.length, 2); assert.ok(copies.some(item => JSON.stringify(item.value) === JSON.stringify(comment)));
    assert.deepEqual(client.quarantinedDrafts().find(item => item.key === `outbox:${queued.id}`)?.value, queued);
    client.reconcileAccess({ L1: access('L1'), F1: access('F1') }, 2, ['S1']);
    await assert.rejects(client.request(queued.path, { method: 'POST', body: queued.body, id: queued.id, queued: true }), /set aside|removed/);
    assert.equal(client.draftIsHeld(draftKey), true); assert.equal(calls, 0, 'access recovery never automatically reanchors or exports');
  } finally { globalThis.fetch = previous; current.close(); }
});

test('already-decoding Word export bytes are discarded after epoch changes or original File denial', async () => {
  for (const denial of ['epoch', 'file'] as const) {
    const current = fixture(), previous = globalThis.fetch; let release!: (value: unknown) => void, signal: AbortSignal | undefined;
    try {
      const response = Response.json({}); Object.defineProperty(response, 'json', { value: () => new Promise(resolve => { release = resolve; }) });
      globalThis.fetch = async (_url, init) => { signal = init?.signal as AbortSignal; return response; };
      const pending = current.client.request(path, { method: 'POST', body: input }, ['F1']); await new Promise<void>(resolve => setImmediate(resolve));
      if (denial === 'epoch') current.client.reconcileAccess({ L1: access('L1'), F1: access('F1') }, 2, ['S1']); else current.client.retireUnavailableObject('F1');
      assert.equal(signal?.aborted, true); release({ accessEpoch: 1, dataBase64: 'PRIVATE_EXPORT' });
      await assert.rejects(pending, (error: unknown) => error instanceof RequestError && ['ACCESS_CHANGED', 'OBJECT_UNAVAILABLE', 'DOCX_SOURCE_UNAVAILABLE'].includes(error.code!));
      assert.equal(current.client.readStored('revision:L1', null), null);
      assert.equal([...current.entries.values()].some(value => value.includes('PRIVATE_EXPORT')), false);
    } finally { globalThis.fetch = previous; current.close(); }
  }
});

test('another tab retiring the Word snapshot aborts pending discussion exports', async () => {
  const current = fixture(), previous = globalThis.fetch; let release!: (response: Response) => void, signal: AbortSignal | undefined, events = 0;
  try {
    current.client.onTaskSnapshotChange(() => events++);
    globalThis.fetch = async (_url, init) => { signal = init?.signal as AbortSignal; return new Promise(resolve => { release = resolve; }); };
    const pending = current.client.request(path, { method: 'POST', body: input }, ['F1']); current.removeElsewhere();
    assert.equal(signal?.aborted, true); assert.equal(events, 1); release(Response.json({ accessEpoch: 1, dataBase64: 'OLD_PRIVATE_EXPORT' }));
    await assert.rejects(pending, /visibility changed|Access changed/);
  } finally { globalThis.fetch = previous; current.close(); }
});

test('Word export responses and passage drafts cannot cross password sessions', async () => {
  const current = fixture('password'), previous = globalThis.fetch; let release!: (response: Response) => void;
  try {
    current.client.writeStored(draftKey, comment);
    globalThis.fetch = async () => new Promise(resolve => { release = resolve; }); const pending = current.client.request(path, { method: 'POST', body: input }, ['F1']);
    const next = createWorkspaceClient(activateSession({ mode: 'password', workspaceId: 'word-discussion', account: { id: 'U2', username: 'other', displayName: 'Other', disabled: false }, sessionContext: 'next-context', csrfToken: 'next-csrf', expiresAt: null }));
    release(Response.json({ accessEpoch: 1, dataBase64: 'OLD_ACCOUNT_EXPORT' })); await assert.rejects(pending, SessionChangedError);
    assert.equal(next.readStored(draftKey, null), null); assert.equal(current.entries.size, 0);
  } finally { globalThis.fetch = previous; current.close(); }
});
