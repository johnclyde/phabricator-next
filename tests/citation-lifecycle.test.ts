import test from 'node:test';
import assert from 'node:assert/strict';
import { canQueue, createWorkspaceClient } from '../client/offline.ts';
import { activateSession, lockSession, SessionChangedError } from '../client/session.ts';
import type { ObjectAccess } from '../shared/policy.ts';

const access = (id: string, interact = true): ObjectAccess => ({ policy: { objectId: id, version: 1, spaceId: 'S1', rules: { view: { kind: 'workspace' }, edit: { kind: 'workspace' }, interact: { kind: 'workspace' } } }, capabilities: { view: true, edit: true, interact, managePolicy: true }, viewLabel: 'Workspace', editLabel: 'Workspace', interactLabel: 'Workspace' });
const source = { fileId: 'F1', sha256: 'a'.repeat(64), bytes: 40, mediaType: 'application/octet-stream' as const };
const key = 'citation-draft:P1:version-one:target-one';
const draft = { source, quote: 'Private supporting quotation', locator: 'page 1', note: 'Unsent observation', verdict: 'supports', attested: true };
const intent = { id: 'exact-create', draft, body: { ...draft, versionId: 'version-one', contentHash: 'b'.repeat(64), targetId: 'target-one', expectedAccessEpoch: 1 } };
const retract = { id: 'exact-retract', recordId: 'record-one', source, body: { expectedRecordVersion: 1, reason: 'Correct the source edition' } };
const path = '/api/revisions/P1/citation-evidence';

function fixture(mode: 'local' | 'password' = 'local', verify = true) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'), entries = new Map<string, string>(); let quota = false;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { get length() { return entries.size; }, key: (index: number) => [...entries.keys()][index] ?? null, getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { if (quota) throw new Error('Quota'); entries.set(key, value); }, removeItem: (key: string) => entries.delete(key) } });
  const client = createWorkspaceClient(activateSession({ mode, workspaceId: 'citation-lifecycle', account: mode === 'password' ? { id: 'U1', username: 'reviewer', displayName: 'Reviewer', disabled: false } : null, sessionContext: mode === 'password' ? 'session-one' : null, csrfToken: mode === 'password' ? 'csrf-one' : null, expiresAt: null }));
  if (verify) client.reconcileAccess({ P1: access('P1'), F1: access('F1'), F2: access('F2') }, 1);
  return { client, entries, failWrites: () => { quota = true; }, close: () => { lockSession(); if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor); else Reflect.deleteProperty(globalThis, 'localStorage'); } };
}

test('citation creation and retraction never enter automatic offline replay', async () => {
  const current = fixture(), previous = globalThis.fetch; let requests = 0;
  try {
    globalThis.fetch = async () => { requests++; return Response.json({}); };
    for (const endpoint of [path, `${path}/record-one/retract`]) {
      assert.equal(canQueue(endpoint, 'POST', intent.body), false);
      await assert.rejects(current.client.request(endpoint, { method: 'POST', body: intent.body, id: intent.id, queued: true }), /requires an explicit online save/);
    }
    assert.equal(requests, 0);
  } finally { globalThis.fetch = previous; current.close(); }
});

test('initial citation reads wait for current workspace authority before loading evidence', async () => {
  const current = fixture('local', false), previous = globalThis.fetch, calls: string[] = []; let release!: (response: Response) => void;
  try {
    globalThis.fetch = async url => { calls.push(String(url)); return String(url).endsWith('/state') ? await new Promise<Response>(resolve => { release = resolve; }) : Response.json({ records: [], nextBefore: null, accessEpoch: 1 }); };
    const pending = current.client.request(`${path}?versionId=version-one`);
    assert.equal(calls.length, 1); assert.ok(calls[0]!.endsWith('/api/state'));
    release(Response.json({ access: { P1: access('P1'), F1: access('F1') }, spaces: [], accessEpoch: 1 }));
    assert.deepEqual(await pending, { records: [], nextBefore: null, accessEpoch: 1 }); assert.equal(calls.length, 2);
  } finally { globalThis.fetch = previous; current.close(); }
});

test('supporting File revocation rejects late evidence without hiding an independent manuscript and preserves drafts for export', async () => {
  const current = fixture(), previous = globalThis.fetch; let release!: (response: Response) => void;
  try {
    const { client } = current;
    client.writeStored('revision:P1', { revision: { id: 'P1', repositoryId: null }, versions: [{ id: 'version-one', files: [{ path: 'paper.tex', content: 'Public manuscript' }], assets: [] }] });
    client.writeStored('file:F1', { private: 'Previously authorized source metadata' });
    client.writeStored(key, draft); client.writeStored(`${key}:request`, intent); client.writeStored(`${key}:retract:record-one`, retract);
    globalThis.fetch = async () => await new Promise<Response>(resolve => { release = resolve; });
    const pending = client.request(`${path}?versionId=version-one`);
    client.reconcileAccess({ P1: access('P1'), F2: access('F2') }, 2);
    release(Response.json({ records: [{ quote: 'Late private quote' }], accessEpoch: 1 }));
    await assert.rejects(pending, /visibility changed|Access changed/);
    assert.equal(client.unavailableObject('F1'), true); assert.equal(client.unavailableObject('P1'), false);
    assert.ok(client.readStored('revision:P1', null)); assert.equal(client.readStored('file:F1', null), null);
    for (const saved of [key, `${key}:request`, `${key}:retract:record-one`]) { assert.equal(client.readStored(saved, null), null); assert.ok(client.quarantinedDrafts().some(item => item.key === saved)); }
    assert.deepEqual(client.quarantinedDrafts().find(item => item.key === `${key}:request`)!.value, intent);
  } finally { globalThis.fetch = previous; current.close(); }
});

test('source denials retire explicit supporting authority for both creation and retraction', async () => {
  const previous = globalThis.fetch;
  try {
    for (const operation of [{ path, body: intent.body, saved: intent, savedKey: `${key}:request` }, { path: `${path}/record-one/retract`, body: retract.body, saved: retract, savedKey: `${key}:retract:record-one` }]) {
      const current = fixture();
      try {
        current.client.writeStored(operation.savedKey, operation.saved);
        globalThis.fetch = async () => Response.json({ error: 'Supporting source is unavailable', code: 'CITATION_SOURCE_UNAVAILABLE' }, { status: 404 });
        await assert.rejects(current.client.request(operation.path, { method: 'POST', body: operation.body, id: operation.saved.id }, ['F1']), /supporting File|Supporting source/);
        assert.equal(current.client.unavailableObject('F1'), true); assert.equal(current.client.unavailableObject('P1'), false);
        assert.equal(current.client.draftIsHeld(operation.savedKey), true); assert.deepEqual(current.client.quarantinedDrafts().find(item => item.key === operation.savedKey)!.value, operation.saved);
      } finally { current.close(); }
    }
  } finally { globalThis.fetch = previous; }
});

test('interact loss holds both attestation and retraction requests and blocks sends even when edit remains allowed', async () => {
  const current = fixture(), previous = globalThis.fetch; let requests = 0;
  try {
    const { client } = current; client.writeStored(key, draft); client.writeStored(`${key}:request`, intent); client.writeStored(`${key}:retract:record-one`, retract);
    client.reconcileAccess({ P1: access('P1', false), F1: access('F1'), F2: access('F2') }, 2);
    assert.equal(client.unavailableObject('P1'), false);
    for (const saved of [key, `${key}:request`, `${key}:retract:record-one`]) assert.equal(client.draftIsHeld(saved), true);
    globalThis.fetch = async () => { requests++; return Response.json({}); };
    await assert.rejects(client.request(path, { method: 'POST', body: intent.body, id: intent.id }, ['F1']), /Permission to submit/);
    await assert.rejects(client.request(`${path}/record-one/retract`, { method: 'POST', body: retract.body, id: retract.id }, ['F1']), /Permission to submit/);
    assert.equal(requests, 0);
  } finally { globalThis.fetch = previous; current.close(); }
});

test('quota-retained evidence and a different durable draft are both recoverable after source loss', () => {
  const current = fixture();
  try {
    const { client } = current, durable = { ...draft, source: { ...source, fileId: 'F2' }, quote: 'Other tab quote' };
    client.writeStored(key, durable); current.failWrites(); assert.equal(client.writeStored(key, draft), false); assert.deepEqual(client.readStored(key, null), draft);
    client.reconcileAccess({ P1: access('P1'), F2: access('F2') }, 2);
    const copies = client.quarantinedDrafts().filter(item => item.key === key || item.key === `${key}:unsaved-memory`).map(item => item.value);
    assert.equal(copies.length, 2); assert.ok(copies.some(item => JSON.stringify(item) === JSON.stringify(durable))); assert.ok(copies.some(item => JSON.stringify(item) === JSON.stringify(draft)));
    assert.equal(client.readStored(key, null), null); assert.ok(client.quarantineWarning());
  } finally { current.close(); }
});

test('protected evidence drafts stay in session memory and late receipts cannot cross account changes', async () => {
  const current = fixture('password'), previous = globalThis.fetch; let release!: (response: Response) => void;
  try {
    const { client } = current; client.writeStored(key, draft); client.writeStored(`${key}:request`, intent);
    assert.equal(current.entries.size, 0); assert.equal(client.draftRecords().length, 2);
    globalThis.fetch = async () => await new Promise<Response>(resolve => { release = resolve; });
    const pending = client.request(path, { method: 'POST', body: intent.body, id: intent.id }, ['F1']);
    const next = createWorkspaceClient(activateSession({ mode: 'password', workspaceId: 'citation-lifecycle', account: { id: 'U2', username: 'other', displayName: 'Other', disabled: false }, sessionContext: 'session-two', csrfToken: 'csrf-two', expiresAt: null }));
    release(Response.json({ quote: draft.quote, accessEpoch: 1 })); await assert.rejects(pending, SessionChangedError);
    assert.equal(next.readStored(key, null), null); assert.equal(client.writeStored(key, draft), false); assert.equal(next.draftRecords().length, 0); assert.equal(current.entries.size, 0);
  } finally { globalThis.fetch = previous; current.close(); }
});
