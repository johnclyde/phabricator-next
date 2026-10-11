import test from 'node:test';
import assert from 'node:assert/strict';
import { canQueue, createWorkspaceClient, type PendingMutation } from '../client/offline.ts';
import { activateSession, lockSession, SessionChangedError } from '../client/session.ts';
import type { ObjectAccess } from '../shared/policy.ts';
import type { WikiAuthority } from '../client/wiki-client.ts';

const access = (id: string, edit = true): ObjectAccess => ({ policy: { objectId: id, version: 1, spaceId: 'S1', rules: { view: { kind: 'workspace' }, edit: { kind: 'workspace' }, interact: { kind: 'workspace' } } }, capabilities: { view: true, edit, interact: true, managePolicy: edit }, viewLabel: 'Workspace', editLabel: 'Workspace', interactLabel: 'Workspace' });
const allAccess = () => Object.fromEntries(['W1', 'W2', 'W3', 'W4', 'W5'].map(id => [id, access(id)]));
const authority: WikiAuthority = { path: 'parent/new/', accessEpoch: 1, ancestorIds: ['W1', 'W2'], parentId: 'W2' };
const createDraft = { title: 'Unsent child', slug: authority.path, content: 'Keep exact source\r\n', message: 'Draft summary', spaceId: 'S2', wikiAuthority: authority };
const create: PendingMutation = { id: 'create-child', path: '/api/documents', method: 'POST', body: { title: createDraft.title, slug: createDraft.slug, content: createDraft.content, access: { spaceId: 'S2' }, expectedAccessEpoch: 1 }, label: 'Create child', createdAt: '2026-01-01T00:00:00.000Z', wikiAuthority: authority };
const { wikiAuthority: _creationAuthority, ...unboundCreate } = create;
const moveDraft = { destinationPath: 'target/new/', message: 'Unsent move explanation', authorityIds: ['W1', 'W2', 'W4', 'W5'], editIds: ['W3', 'W4', 'W5'] };
const move = { id: 'exact-move', sourceId: 'W3', input: { destinationPath: moveDraft.destinationPath, expectedVersion: 1, expectedSourceVersionId: 'source-version-one', expectedDestinationId: 'W5', expectedDestinationVersion: 2, expectedAccessEpoch: 1, message: moveDraft.message }, draft: moveDraft, authorityIds: moveDraft.authorityIds, editIds: moveDraft.editIds };

function fixture(mode: 'local' | 'password' = 'local', verify = true) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'), entries = new Map<string, string>(); let quota = false;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { get length() { return entries.size; }, key: (index: number) => [...entries.keys()][index] ?? null, getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { if (quota) throw new Error('Quota'); entries.set(key, value); }, removeItem: (key: string) => entries.delete(key) } });
  const client = createWorkspaceClient(activateSession({ mode, workspaceId: 'wiki-lifecycle', account: mode === 'password' ? { id: 'U1', username: 'reviewer', displayName: 'Reviewer', disabled: false } : null, sessionContext: mode === 'password' ? 'session-one' : null, csrfToken: mode === 'password' ? 'csrf-one' : null, expiresAt: null }));
  if (verify) client.reconcileAccess(allAccess(), 1, ['S1', 'S2']);
  return { client, entries, failWrites: () => { quota = true; }, close: () => { lockSession(); if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor); else Reflect.deleteProperty(globalThis, 'localStorage'); } };
}

test('wiki creation drafts and queued requests are held after ancestor view, parent edit or destination Space loss', async () => {
  const previous = globalThis.fetch; let requests = 0;
  try {
    globalThis.fetch = async () => { requests++; return Response.json({}); };
    for (const loss of ['ancestor', 'parent-edit', 'space']) {
      const current = fixture();
      try {
        const { client } = current; client.writeStored('draft:document:new', createDraft); client.writeStored('outbox', [create]);
        const changed = allAccess(); if (loss === 'ancestor') delete changed.W1; if (loss === 'parent-edit') changed.W2 = access('W2', false);
        client.reconcileAccess(changed, 2, loss === 'space' ? ['S1'] : ['S1', 'S2']);
        assert.equal(client.draftIsHeld('draft:document:new'), true, loss); assert.equal(client.readStored('draft:document:new', null), null);
        assert.deepEqual(client.readStored('outbox', []), []); assert.deepEqual(client.quarantinedDrafts().find(item => item.key === 'outbox:create-child')?.value, create);
        assert.deepEqual(client.quarantinedDrafts().find(item => item.key === 'draft:document:new')?.value, createDraft);
        await assert.rejects(client.request(create.path, { method: create.method, body: create.body, id: create.id, queued: true }), /set aside|removed|export/i);
        client.reconcileAccess(allAccess(), 3, ['S1', 'S2']); assert.equal(client.draftIsHeld('draft:document:new'), true); assert.deepEqual(client.readStored('outbox', []), [], 'restoring access never automatically submits held work');
      } finally { current.close(); }
    }
    assert.equal(requests, 0);
  } finally { globalThis.fetch = previous; }
});

test('ordinary same-path wiki edits remain queueable when only the parent loses edit permission', async () => {
  const current = fixture(), previous = globalThis.fetch;
  try {
    const { client } = current, draft = { title: 'Child', slug: 'parent/child/', content: 'Edited child source', expectedVersion: 3 };
    const edit: PendingMutation = { ...unboundCreate, id: 'ordinary-edit', path: '/api/documents/W3', method: 'PUT', body: draft };
    client.writeStored('state', { documents: [{ id: 'W3', slug: draft.slug, version: 3, location: { path: draft.slug, status: 'active' } }] }); client.writeStored('draft:document:W3:3', draft); client.writeStored('outbox', [edit]);
    client.reconcileAccess({ ...allAccess(), W2: access('W2', false) }, 2, ['S1', 'S2']);
    assert.equal(client.draftIsHeld('draft:document:W3:3'), false); assert.deepEqual(client.readStored('outbox', []), [edit]);
    let requests = 0; globalThis.fetch = async (_url, options) => { requests++; assert.deepEqual(JSON.parse(String(options?.body)), draft); return Response.json({ id: 'W3', version: 4, accessEpoch: 2 }); };
    await client.request(edit.path, { method: edit.method, body: edit.body, id: edit.id, queued: true }); assert.equal(requests, 1);
  } finally { globalThis.fetch = previous; current.close(); }
});

test('legacy unreviewed creation, rename and stale moved-page writes are held while pinned same-path edits survive', () => {
  const current = fixture();
  try {
    const { client, entries } = current;
    client.writeStored('state', { documents: [{ id: 'W3', slug: 'parent/child/', version: 3, location: { path: 'parent/child/', status: 'active' } }, { id: 'W4', slug: 'moved/', version: 4, location: { path: 'moved/', status: 'moved' } }] });
    const operations: PendingMutation[] = [
      { ...unboundCreate, id: 'legacy-create', body: { slug: 'parent/new', title: 'Old draft' } },
      { ...unboundCreate, id: 'unbound-create' },
      { ...unboundCreate, id: 'legacy-rename', path: '/api/documents/W3', method: 'PUT', body: { slug: 'elsewhere/', content: 'Rename draft', expectedVersion: 3 } },
      { ...unboundCreate, id: 'same-path', path: '/api/documents/W3', method: 'PUT', body: { slug: 'parent/child', content: 'Content draft', expectedVersion: 3 } },
      { ...unboundCreate, id: 'stale-moved', path: '/api/documents/W4', method: 'PUT', body: { slug: 'moved/', content: 'Before move draft', expectedVersion: 3 } },
      { ...unboundCreate, id: 'reviewed-recreation', path: '/api/documents/W4', method: 'PUT', body: { slug: 'moved/', content: 'Explicit recreation', expectedVersion: 4 } },
      create,
    ];
    entries.set(client.storageKey('outbox'), JSON.stringify(operations));
    assert.deepEqual(client.readStored<PendingMutation[]>('outbox', []).map(item => item.id), ['same-path', 'reviewed-recreation', create.id]);
    for (const id of ['legacy-create', 'unbound-create', 'legacy-rename', 'stale-moved']) assert.deepEqual(client.quarantinedDrafts().find(item => item.key === `outbox:${id}`)?.value, operations.find(item => item.id === id));
  } finally { current.close(); }
});

test('wiki moves never replay automatically, and every source or destination dependency holds exact recovery', async () => {
  const previous = globalThis.fetch; let requests = 0;
  try {
    globalThis.fetch = async () => { requests++; return Response.json({}); };
    for (const loss of ['W1-view', 'W2-view', 'W3-view', 'W4-view', 'W5-view', 'W3-edit', 'W4-edit', 'W5-edit']) {
      const current = fixture();
      try {
        const { client } = current; client.writeStored('wiki-move:W3', moveDraft); client.writeStored('wiki-request:W3', move);
        assert.equal(canQueue('/api/documents/W3/move', 'POST', move.input), false);
        await assert.rejects(client.request('/api/documents/W3/move', { method: 'POST', body: move.input, id: move.id, queued: true }), /explicit online save/);
        const changed = allAccess(), [id, capability] = loss.split('-'); if (capability === 'view') delete changed[id!]; else changed[id!] = access(id!, false);
        client.reconcileAccess(changed, 2, ['S1', 'S2']);
        for (const [key, value] of [['wiki-move:W3', moveDraft], ['wiki-request:W3', move]] as const) { assert.equal(client.draftIsHeld(key), true, loss); assert.equal(client.readStored(key, null), null); assert.deepEqual(client.quarantinedDrafts().find(item => item.key === key)?.value, value); }
      } finally { current.close(); }
    }
    assert.equal(requests, 0);
  } finally { globalThis.fetch = previous; }
});

test('wiki quota-retained creation and move drafts preserve both competing copies when their dependency disappears', () => {
  for (const [key, draft] of [['draft:document:new', createDraft], ['wiki-move:W3', moveDraft]] as const) {
    const current = fixture();
    try {
      const { client } = current, other = { ...draft, message: 'Different draft saved by another tab' };
      client.writeStored(key, other); current.failWrites(); assert.equal(client.writeStored(key, draft), false);
      const changed = allAccess(); delete changed.W2; client.reconcileAccess(changed, 2, ['S1', 'S2']);
      const copies = client.quarantinedDrafts().filter(item => item.key === key || item.key === `${key}:unsaved-memory`).map(item => item.value);
      assert.equal(copies.length, 2); assert.ok(copies.some(item => JSON.stringify(item) === JSON.stringify(other))); assert.ok(copies.some(item => JSON.stringify(item) === JSON.stringify(draft))); assert.equal(client.readStored(key, null), null);
    } finally { current.close(); }
  }
});

test('wiki epoch changes retire every cached hierarchy and reject a late version response without discarding drafts', async () => {
  const current = fixture(), previous = globalThis.fetch; let release!: (response: Response) => void;
  try {
    const { client } = current, keys = ['wiki:W3', 'wiki:W3:version:1', 'wiki-path:parent/child/'];
    for (const key of keys) client.writeStored(key, { hiddenPeer: 'Old target title', accessEpoch: 1 });
    client.writeStored('wiki-move:W3', moveDraft);
    globalThis.fetch = async () => await new Promise<Response>(resolve => { release = resolve; });
    const pending = client.request('/api/documents/W3/versions/1'); client.reconcileAccess(allAccess(), 2, ['S1', 'S2']);
    release(Response.json({ content: 'Old content with stale move target', accessEpoch: 1 })); await assert.rejects(pending, /changed|access|unavailable/i);
    for (const key of keys) { assert.equal(client.readStored(key, null), null); assert.equal(client.writeStored(key, { hiddenPeer: 'Old target title', accessEpoch: 1 }), false); }
    assert.deepEqual(client.readStored('wiki-move:W3', null), moveDraft);
    globalThis.fetch = async () => Response.json({ error: 'A wiki destination is unavailable', code: 'WIKI_PATH_UNAVAILABLE' }, { status: 404 });
    await assert.rejects(client.request('/api/documents/W3/move-preview?path=target/new/'), /destination is unavailable/); assert.equal(client.unavailableObject('W3'), false, 'destination denial does not retire a still-visible source');
  } finally { globalThis.fetch = previous; current.close(); }
});

test('direct wiki reads remain session-bound and protected recovery cannot cross account changes', async () => {
  const current = fixture('password', false), previous = globalThis.fetch; let release!: (response: Response) => void;
  try {
    const { client } = current; const requests: string[] = [];
    globalThis.fetch = async url => { requests.push(String(url)); return String(url).endsWith('/state') ? Response.json({ access: allAccess(), accessEpoch: 1, spaces: [{ id: 'S1' }, { id: 'S2' }] }) : await new Promise<Response>(resolve => { release = resolve; }); };
    const pending = client.request('/api/documents/W3/versions/1'); assert.equal(requests.length, 1); assert.ok(requests[0]!.endsWith('/api/documents/W3/versions/1')); client.writeStored('wiki-request:W3', move); assert.equal(current.entries.size, 0);
    const next = createWorkspaceClient(activateSession({ mode: 'password', workspaceId: 'wiki-lifecycle', account: { id: 'U2', username: 'other', displayName: 'Other', disabled: false }, sessionContext: 'session-two', csrfToken: 'csrf-two', expiresAt: null }));
    release(Response.json({ content: 'Private version source', accessEpoch: 1 })); await assert.rejects(pending, SessionChangedError);
    assert.equal(next.readStored('wiki-request:W3', null), null); assert.equal(client.writeStored('wiki-request:W3', move), false); assert.equal(current.entries.size, 0);
  } finally { globalThis.fetch = previous; current.close(); }
});

test('initial wiki mutations wait for workspace verification and obey newly learned write restrictions', async () => {
  const previous = globalThis.fetch;
  try {
    for (const editable of [true, false]) {
      const current = fixture('password', false); let release!: (response: Response) => void; const calls: string[] = [];
      try {
        globalThis.fetch = async url => { calls.push(String(url)); return String(url).endsWith('/state') ? await new Promise<Response>(resolve => { release = resolve; }) : Response.json({ id: 'W3', version: 2, accessEpoch: 1 }); };
        const pending = current.client.request('/api/documents/W3', { method: 'PUT', id: 'initial-write', body: { title: 'Title', slug: 'parent/child/', content: 'Changed source', expectedVersion: 1 } });
        assert.equal(calls.length, 1); assert.ok(calls[0]!.endsWith('/api/state'));
        release(Response.json({ access: { ...allAccess(), W3: access('W3', editable) }, accessEpoch: 1, spaces: [{ id: 'S1' }, { id: 'S2' }] }));
        if (editable) { await pending; assert.equal(calls.length, 2); assert.ok(calls[1]!.endsWith('/api/documents/W3')); }
        else { await assert.rejects(pending, /Permission to submit/); assert.equal(calls.length, 1); }
      } finally { current.close(); }
    }
  } finally { globalThis.fetch = previous; }
});

const publicationPins = { expectedVersion: 2, expectedHeadVersionId: 'head-two', expectedPublishedVersionId: 'published-one', expectedPublicationRevision: 3, expectedAccessEpoch: 1 };
const publicationDraft = { title: 'Unsent shared draft', content: 'Keep this exact local text\r\n', message: 'Unsent summary', pins: publicationPins, authorityIds: ['W1', 'W2'] };
const actionDraft = { message: 'Unsent publication explanation', authorityIds: ['W1', 'W2'] };
const publicationIntent = { id: 'exact-publish', documentId: 'W3', kind: 'publish', path: '/api/documents/W3/publish', method: 'POST' as const, body: { ...publicationPins, targetVersionId: 'head-two', message: actionDraft.message }, draftKey: 'wiki-action:W3:3:publish:head-two', draft: actionDraft, authorityIds: ['W1', 'W2'] };
const publicationRecords = [['wiki-edit:W3:head-two:3', publicationDraft], [publicationIntent.draftKey, actionDraft], ['wiki-action-request:W3', publicationIntent]] as const;

test('wiki publication operations never enter the outbox and retained local work follows ancestor and source permissions', async () => {
  const previous = globalThis.fetch; let requests = 0;
  try {
    globalThis.fetch = async () => { requests++; return Response.json({}); };
    for (const loss of ['ancestor-view', 'source-view', 'source-edit']) {
      const current = fixture();
      try {
        const { client } = current;
        for (const [key, value] of publicationRecords) assert.equal(client.writeStored(key, value), true);
        for (const action of ['drafts', 'publish', 'delete']) {
          const path = `/api/documents/W3/${action}`; assert.equal(canQueue(path, 'POST', publicationIntent.body), false);
          await assert.rejects(client.request(path, { method: 'POST', id: publicationIntent.id, body: publicationIntent.body, queued: true }), /explicit online save/);
        }
        const changed = allAccess(); if (loss === 'ancestor-view') delete changed.W2; else if (loss === 'source-view') delete changed.W3; else changed.W3 = access('W3', false);
        client.reconcileAccess(changed, 2, ['S1', 'S2']);
        for (const [key, value] of publicationRecords) { assert.equal(client.draftIsHeld(key), true, `${loss}: ${key}`); assert.equal(client.readStored(key, null), null); assert.deepEqual(client.quarantinedDrafts().find(item => item.key === key)?.value, value); }
        client.reconcileAccess(allAccess(), 3, ['S1', 'S2']); for (const [key] of publicationRecords) assert.equal(client.draftIsHeld(key), true);
      } finally { current.close(); }
    }
    assert.equal(requests, 0);
  } finally { globalThis.fetch = previous; }
});

test('wiki lifecycle recovery preserves both quota copies and late confirmations never remove a newer local draft', () => {
  for (const [key, draft] of publicationRecords) {
    const current = fixture();
    try {
      const { client } = current, other = { ...draft, message: 'Different newer local note' };
      client.writeStored(key, draft); client.writeStored(key, other); client.removeStoredIfEqual(key, draft); assert.deepEqual(client.readStored(key, null), other);
      current.failWrites(); assert.equal(client.writeStored(key, draft), false);
      const changed = allAccess(); delete changed.W2; client.reconcileAccess(changed, 2, ['S1', 'S2']);
      const copies = client.quarantinedDrafts().filter(item => item.key === key || item.key === `${key}:unsaved-memory`).map(item => item.value);
      assert.equal(copies.length, 2); assert.ok(copies.some(item => JSON.stringify(item) === JSON.stringify(other))); assert.ok(copies.some(item => JSON.stringify(item) === JSON.stringify(draft)));
    } finally { current.close(); }
  }
});

test('wiki lifecycle local drafts retain original publication pins across unrelated policy refreshes and ordinary parent edit loss', () => {
  const current = fixture();
  try {
    const { client } = current; for (const [key, value] of publicationRecords) client.writeStored(key, value);
    client.reconcileAccess({ ...allAccess(), W2: access('W2', false) }, 2, ['S1', 'S2']);
    for (const [key, value] of publicationRecords) { assert.equal(client.draftIsHeld(key), false); assert.deepEqual(client.readStored(key, null), value); }
    assert.equal(client.readStored<typeof publicationIntent>('wiki-action-request:W3', publicationIntent).body.expectedAccessEpoch, 1, 'a retained request never silently substitutes current access or publication pins');
  } finally { current.close(); }
});
