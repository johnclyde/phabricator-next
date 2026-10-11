import test from 'node:test';
import assert from 'node:assert/strict';
import { canQueue, createWorkspaceClient } from '../client/offline.ts';
import { activateSession, lockSession, SessionChangedError } from '../client/session.ts';
import { docxBytes, docxReceiptVersion, type DocxIntent } from '../client/docx-client.ts';
import type { ObjectAccess } from '../shared/policy.ts';
import type { RevisionDetail, RevisionVersion } from '../shared/types.ts';

const access = (id: string, edit = true): ObjectAccess => ({ policy: { objectId: id, version: 1, spaceId: 'S1', rules: { view: { kind: 'workspace' }, edit: { kind: 'workspace' }, interact: { kind: 'workspace' } } }, capabilities: { view: true, edit, interact: true, managePolicy: edit }, viewLabel: 'Workspace', editLabel: 'Workspace', interactLabel: 'Workspace' });
const source = (fileId = 'F1') => ({ fileId, sha256: 'b'.repeat(64), bytes: 100 });
function version(number = 1, fileId = 'F1'): RevisionVersion {
  return { id: `version-${number}`, revisionId: 'L1', number, files: [], contentHash: 'a'.repeat(64), message: 'Imported', createdAt: '2026-10-11T12:00:00Z', docx: { format: 'docx', fileName: 'private.docx', sha256: 'b'.repeat(64), bytes: 100, sourceFile: source(fileId), projection: { format: 'phabricator.docx.projection.v1', mainPart: 'word/document.xml', blocks: [{ id: 'p1', part: 'word/document.xml', kind: 'paragraph', text: 'Private source', runs: [{ text: 'Private source' }] }], notes: [], comments: [], changes: [], editableRanges: [], warnings: [] } } };
}
function detail(versions = [version()]): RevisionDetail {
  return { revision: { id: 'L1', kind: 'document', title: 'Private Word draft', summary: '', status: 'needs_review', repositoryId: null, projectId: null, currentVersion: versions.at(-1)!.number, createdAt: '2026-10-11T12:00:00Z', updatedAt: '2026-10-11T12:00:00Z' }, versions, comments: [], threads: [], threadEvents: [], suggestionApplications: [], reviews: [], activity: [], accessEpoch: 1 };
}
const draft = { sourceFile: source(), rangeId: 'range', start: 0, end: 7, replacement: 'Retain my changes 😀', message: 'Exact note\r\n' };
const draftKey = 'docx-draft:L1:version-1:replace';
const intent: DocxIntent = { id: 'exact-docx-request', path: '/api/revisions/L1/docx/replace', sourceFile: source(), draftKey, draft, base: { id: 'version-1', number: 1, contentHash: 'a'.repeat(64), packageHash: 'b'.repeat(64) }, body: { expectedVersion: 1, expectedVersionId: 'version-1', expectedContentHash: 'a'.repeat(64), expectedAccessEpoch: 1, rangeId: 'range', start: 0, end: 7, quote: 'Private', replacement: draft.replacement, message: draft.message } };
function fixture(mode: 'local' | 'password' = 'local', verified = true, storageEvents = false) {
  const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'), windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const entries = new Map<string, string>(), events = new EventTarget(); let quota = false;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { get length() { return entries.size; }, key: (index: number) => [...entries.keys()][index] ?? null, getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { if (quota) throw new Error('Quota'); entries.set(key, value); }, removeItem: (key: string) => entries.delete(key) } });
  if (storageEvents) Object.defineProperty(globalThis, 'window', { configurable: true, value: events });
  const client = createWorkspaceClient(activateSession({ mode, workspaceId: 'docx-lifecycle', account: mode === 'password' ? { id: 'U1', username: 'reviewer', displayName: 'Reviewer', disabled: false } : null, sessionContext: mode === 'password' ? 'session-one' : null, csrfToken: mode === 'password' ? 'csrf-one' : null, expiresAt: null }));
  if (verified) client.reconcileAccess({ L1: access('L1'), F1: access('F1'), F2: access('F2') }, 1, ['S1', 'S2']);
  return { client, entries, failWrites: () => { quota = true; }, storageRemoved: (key: string) => { const oldValue = entries.get(client.storageKey(key)) ?? null; entries.delete(client.storageKey(key)); const event = new Event('storage'); Object.assign(event, { key: client.storageKey(key), oldValue, newValue: null }); events.dispatchEvent(event); }, close: () => { lockSession(); if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor); else Reflect.deleteProperty(globalThis, 'localStorage'); if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor); else Reflect.deleteProperty(globalThis, 'window'); } };
}

test('DOCX writes require explicit online submission and never enter the automatic outbox', async () => {
  const current = fixture(), previous = globalThis.fetch; let requests = 0;
  try {
    globalThis.fetch = async () => { requests++; return Response.json({}); };
    for (const path of ['/api/revisions/docx', '/api/revisions/L1/docx/import', intent.path]) {
      assert.equal(canQueue(path, 'POST', intent.body), false);
      await assert.rejects(current.client.request(path, { method: 'POST', body: intent.body, id: intent.id, queued: true }), /explicit online save/);
    }
    assert.equal(requests, 0);
  } finally { globalThis.fetch = previous; current.close(); }
});

test('Word inspection verifies initial access before fetching protected source', async () => {
  const current = fixture('local', false), previous = globalThis.fetch, calls: string[] = []; let release!: (response: Response) => void;
  try {
    globalThis.fetch = async url => { calls.push(String(url)); return String(url).endsWith('/state') ? await new Promise<Response>(resolve => { release = resolve; }) : Response.json({ sourceFile: source(), accessEpoch: 1 }); };
    const pending = current.client.request('/api/files/F1/docx'); assert.equal(calls.length, 1); assert.ok(calls[0]!.endsWith('/api/state'));
    release(Response.json({ access: { F1: access('F1') }, spaces: [{ id: 'S1' }], accessEpoch: 1 }));
    assert.deepEqual(await pending, { sourceFile: source(), accessEpoch: 1 }); assert.equal(calls.length, 2);
  } finally { globalThis.fetch = previous; current.close(); }
});

test('a historical DOCX source revocation purges projection caches and retains exact edit/request bytes without automatic revival', () => {
  const current = fixture();
  try {
    const { client } = current; client.writeStored('revision:L1', detail([version(1, 'F1'), version(2, 'F2')]));
    client.writeStored(draftKey, draft); client.writeStored('docx-request:L1', intent); client.retireUnavailableObject('F1');
    assert.equal(client.unavailableObject('L1'), true); assert.equal(client.readStored('revision:L1', null), null);
    for (const key of [draftKey, 'docx-request:L1']) { assert.equal(client.readStored(key, null), null); assert.equal(client.draftIsHeld(key), true); }
    assert.deepEqual(client.quarantinedDrafts().find(item => item.key === draftKey)!.value, draft); assert.deepEqual(client.quarantinedDrafts().find(item => item.key === 'docx-request:L1')!.value, intent);
    client.reconcileAccess({ L1: access('L1'), F1: access('F1'), F2: access('F2') }, 2, ['S1']);
    assert.equal(client.readStored('revision:L1', null), null); assert.equal(client.draftIsHeld(draftKey), true); assert.equal(client.draftIsHeld('docx-request:L1'), true);
  } finally { current.close(); }
});

test('DOCX edit loss and destination Space loss hold exact requests without hiding still-viewable source', () => {
  const current = fixture();
  try {
    const { client } = current; client.writeStored(draftKey, draft); client.writeStored('docx-request:L1', intent);
    client.reconcileAccess({ L1: access('L1', false), F1: access('F1'), F2: access('F2') }, 2, ['S1', 'S2']);
    assert.equal(client.unavailableObject('L1'), false); assert.equal(client.draftIsHeld(draftKey), true); assert.equal(client.draftIsHeld('docx-request:L1'), true);
    const key = 'docx-draft:S2:create', creation = { testPlan: 'Fixture verification plan.', title: 'Keep new draft', summary: '', message: '', sourceFile: source(), shareSource: false };
    const request = { id: 'new-docx', path: '/api/revisions/docx', body: { testPlan: 'Fixture verification plan.', title: creation.title, sourceFile: source(), expectedAccessEpoch: 2, shareSource: false, access: { spaceId: 'S2' } }, sourceFile: source(), draftKey: key, draft: creation };
    client.writeStored(key, creation); client.writeStored('docx-request:S2', request);
    client.reconcileAccess({ L1: access('L1', false), F1: access('F1'), F2: access('F2') }, 3, ['S1']);
    assert.equal(client.draftIsHeld(key), true); assert.equal(client.draftIsHeld('docx-request:S2'), true); assert.deepEqual(client.quarantinedDrafts().find(item => item.key === key)!.value, creation);
  } finally { current.close(); }
});

test('late document responses and obsolete cache writes cannot restore projection after an epoch change', async () => {
  const current = fixture(), previous = globalThis.fetch; let release!: (response: Response) => void;
  try {
    const { client } = current; client.writeStored('revision:L1', detail()); client.writeStored(draftKey, draft);
    globalThis.fetch = async () => await new Promise<Response>(resolve => { release = resolve; });
    const pending = client.request('/api/revisions/L1'); client.reconcileAccess({ L1: access('L1'), F1: access('F1'), F2: access('F2') }, 2, ['S1']);
    release(Response.json(detail())); await assert.rejects(pending, /visibility|Access changed/i);
    assert.equal(client.readStored('revision:L1', null), null); assert.equal(client.writeStored('revision:L1', detail()), false);
    assert.deepEqual(client.readStored(draftKey, null), draft, 'unrelated epoch changes retain editable work');
  } finally { globalThis.fetch = previous; current.close(); }
});

test('a denied reimport File retires its request without revoking an independently visible current document', async () => {
  const current = fixture(), previous = globalThis.fetch;
  try {
    const { client } = current; client.writeStored('revision:L1', detail());
    const importing = { ...intent, path: '/api/revisions/L1/docx/import', sourceFile: source('F2'), body: { ...intent.base, sourceFile: source('F2'), message: 'Reimport' }, draftKey: 'docx-draft:L1:version-1:import', draft: { sourceFile: source('F2'), message: 'Keep import' } };
    client.writeStored(importing.draftKey, importing.draft); client.writeStored('docx-request:L1', importing);
    globalThis.fetch = async () => Response.json({ error: 'Unavailable source', code: 'DOCX_SOURCE_UNAVAILABLE' }, { status: 404 });
    await assert.rejects(client.request(importing.path, { method: 'POST', body: importing.body, id: importing.id }, ['F2']), { code: 'DOCX_SOURCE_UNAVAILABLE' });
    assert.equal(client.unavailableObject('F2'), true); assert.equal(client.unavailableObject('L1'), false); assert.equal(client.draftIsHeld(importing.draftKey), true); assert.equal(client.draftIsHeld('docx-request:L1'), true);
  } finally { globalThis.fetch = previous; current.close(); }
});

test('source loss during a Word download rejects late bytes and aborts its transport', async () => {
  const current = fixture(), previous = globalThis.fetch; let release!: (response: Response) => void, signal: AbortSignal | null | undefined;
  try {
    const { client } = current; client.writeStored('revision:L1', detail());
    globalThis.fetch = async (_url, options) => { signal = options?.signal; return await new Promise<Response>(resolve => { release = resolve; }); };
    const pending = docxBytes(client, 'L1', version() as RevisionVersion & { docx: NonNullable<RevisionVersion['docx']> }, new AbortController().signal);
    client.retireUnavailableObject('F1'); assert.equal(signal?.aborted, true); release(new Response(new Uint8Array(100)));
    await assert.rejects(pending, /access changed/i);
  } finally { globalThis.fetch = previous; current.close(); }
});

test('protected Word drafts and late receipts stay bound to one session', async () => {
  const current = fixture('password'), previous = globalThis.fetch; let release!: (response: Response) => void;
  try {
    current.client.writeStored(draftKey, draft); current.client.writeStored('docx-request:L1', intent); assert.equal(current.entries.size, 0);
    globalThis.fetch = async () => await new Promise<Response>(resolve => { release = resolve; });
    const pending = current.client.request(intent.path, { method: 'POST', body: intent.body, id: intent.id }, ['F1']);
    const next = createWorkspaceClient(activateSession({ mode: 'password', workspaceId: 'docx-lifecycle', account: { id: 'U2', username: 'other', displayName: 'Other', disabled: false }, sessionContext: 'session-two', csrfToken: 'csrf-two', expiresAt: null }));
    release(Response.json(detail())); await assert.rejects(pending, SessionChangedError);
    assert.equal(next.readStored(draftKey, null), null); assert.equal(next.readStored('docx-request:L1', null), null); assert.equal(current.entries.size, 0);
  } finally { globalThis.fetch = previous; current.close(); }
});

test('quota-retained and durable Word drafts both remain exportable after revocation', () => {
  const current = fixture();
  try {
    current.client.writeStored(draftKey, { ...draft, replacement: 'Other tab' }); current.failWrites(); assert.equal(current.client.writeStored(draftKey, draft), false);
    current.client.retireUnavailableObject('F1');
    const copies = current.client.quarantinedDrafts().filter(item => item.key === draftKey || item.key === `${draftKey}:unsaved-memory`).map(item => item.value);
    assert.equal(copies.length, 2); assert.ok(copies.some(item => JSON.stringify(item) === JSON.stringify(draft))); assert.ok(current.client.quarantineWarning());
  } finally { current.close(); }
});

test('Word receipt matching preserves exact message whitespace', () => {
  const first = version(), next = { ...version(2), message: draft.message, docx: { ...version(2).docx!, sha256: 'c'.repeat(64) } };
  assert.deepEqual(docxReceiptVersion(detail([first, next]), intent), next);
});

test('a DOCX cache removed by another tab immediately retires the mounted reading snapshot', () => {
  const current = fixture('local', true, true); let snapshots = 0;
  try {
    current.client.writeStored('revision:L1', detail()); const stop = current.client.onTaskSnapshotChange(() => { snapshots++; });
    current.storageRemoved('revision:L1'); assert.equal(snapshots, 1); assert.equal(current.client.readStored('revision:L1', null), null); stop();
  } finally { current.close(); }
});
