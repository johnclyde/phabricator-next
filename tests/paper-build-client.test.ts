import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { paperArtifact, paperRequests, paperRequestMatches, sourcePoint, pdfPoint } from '../client/paper-build-client.ts';
import { createWorkspaceClient, canQueue } from '../client/offline.ts';
import { activateSession, lockSession } from '../client/session.ts';
import type { PaperBuild, PaperSyncTeXMap } from '../shared/paper-builds.ts';
import type { ObjectAccess } from '../shared/policy.ts';

const access: ObjectAccess = { policy: { objectId: 'P1', version: 1, spaceId: 'S1', rules: { view: { kind: 'workspace' }, edit: { kind: 'workspace' }, interact: { kind: 'workspace' } } }, capabilities: { view: true, edit: true, interact: true, managePolicy: false }, viewLabel: 'Workspace', editLabel: 'Workspace', interactLabel: 'Workspace' };
const input = { versionId: 'version-1', contentHash: 'a'.repeat(64), entrypoint: 'main.tex', toolchainId: 'b'.repeat(64) };
const intent = { id: 'a1628453-7180-48b3-a12c-caa6c8f9f523', revisionId: 'P1', action: 'compile' as const, buildId: null, input, createdAt: '2026-01-01T00:00:00Z' };
const makeClient = () => { const client = createWorkspaceClient(activateSession({ mode: 'password', workspaceId: 'paper', account: { id: 'alice', username: 'alice', displayName: 'Alice', disabled: false }, sessionContext: 'context-alice', csrfToken: 'csrf', expiresAt: null })); client.reconcileAccess({ P1: access, R1: access }, 1); return client; };
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');

test('paper requests retain exact pins, omit unrelated contents and never enter the offline outbox', () => {
  assert.deepEqual(paperRequests([{ ...intent, source: 'not retained', input: { ...input, source: 'not retained' } }], 'P1'), [intent]);
  assert.deepEqual(paperRequests([intent], 'P2'), []);
  const build = { ...input, revisionId: 'P1', id: 'PB1' } as PaperBuild;
  assert.equal(paperRequestMatches(build, intent), true);
  for (const key of ['versionId', 'contentHash', 'entrypoint', 'toolchainId'] as const) assert.equal(paperRequestMatches({ ...build, [key]: 'changed' }, intent), false);
  assert.equal(paperRequestMatches(build, { ...intent, action: 'retry', buildId: 'PB1' }), false);
  assert.equal(paperRequestMatches(build, { ...intent, action: 'cancel', buildId: 'PB2' }), false);
  for (const path of ['/api/revisions/P1/paper-builds', '/api/revisions/P1/paper-builds/PB1/cancel', '/api/revisions/P1/paper-builds/PB1/retry']) assert.equal(canQueue(path, 'POST', input), false);
});

test('source/PDF mapping remains in the chosen version map and uses bounded nearest coordinates', () => {
  const map: PaperSyncTeXMap = { origin: 'top-left', units: 'pt', pages: [{ page: 1, width: 600, height: 800 }], points: [{ path: 'main.tex', line: 5, page: 1, x: 50, y: 100, width: 300, height: 15 }, { path: 'chapter.tex', line: 5, page: 1, x: 50, y: 200, width: 300, height: 20 }, { path: 'main.tex', line: 9, page: 2, x: 50, y: 50, width: 200, height: 15 }] };
  assert.equal(sourcePoint(map, 'chapter.tex', 6), map.points[1]); assert.equal(sourcePoint(map, 'main.tex', 8), map.points[2]); assert.equal(sourcePoint(map, 'absent.tex', 5), null);
  assert.equal(pdfPoint(map, 1, 75, 215), map.points[1]); assert.equal(pdfPoint(map, 1, 75, 90), map.points[0]); assert.equal(pdfPoint(map, 3, 0, 0), null);
});

test('authenticated artifacts verify byte limits and hashes, reject redirects and allow empty logs', async () => {
  const original = globalThis.fetch; const client = makeClient(); const controller = new AbortController(); const data = new TextEncoder().encode('%PDF test');
  try {
    globalThis.fetch = async (_path, options) => { assert.equal(options?.redirect, 'error'); assert.equal(options?.cache, 'no-store'); assert.deepEqual(options?.headers, { 'X-Session-Context': 'context-alice' }); return new Response(data, { headers: { 'X-Access-Epoch': '1', 'Content-Length': String(data.length) } }); };
    assert.deepEqual(await paperArtifact(client, 'P1', 'PB1', 'pdf', data.length, digest(data), controller.signal), data);
    await assert.rejects(paperArtifact(client, 'P1', 'PB1', 'pdf', data.length, '0'.repeat(64), controller.signal), /immutable build record/);
    globalThis.fetch = async () => new Response(data, { headers: { 'X-Access-Epoch': '1', 'Content-Length': '1' } });
    await assert.rejects(paperArtifact(client, 'P1', 'PB1', 'log', 1, digest(data), controller.signal), /exceeded/);
    globalThis.fetch = async () => new Response(new Uint8Array(), { headers: { 'X-Access-Epoch': '1', 'Content-Length': '0' } });
    assert.equal((await paperArtifact(client, 'P1', 'PB1', 'log', 0, digest(new Uint8Array()), controller.signal)).length, 0);
    await assert.rejects(paperArtifact(client, 'P1', 'PB1', 'pdf', 0, digest(new Uint8Array()), controller.signal), /size/);
  } finally { globalThis.fetch = original; lockSession(); }
});

test('held artifact bytes and pending request metadata retire on repository visibility or account changes', async () => {
  const original = globalThis.fetch; const client = makeClient(); const data = new TextEncoder().encode('private artifact');
  try {
    client.writeStored('revision:P1', { revision: { id: 'P1', repositoryId: 'R1' } }); client.writeStored('revision:P1:paper-build-requests', [intent]);
    let release!: (value: Response) => void; globalThis.fetch = async () => new Promise(resolve => { release = resolve; });
    const held = paperArtifact(client, 'P1', 'PB1', 'pdf', data.length, digest(data), new AbortController().signal);
    client.reconcileAccess({ P1: access }, 2); release(new Response(data, { headers: { 'X-Access-Epoch': '1', 'Content-Length': String(data.length) } }));
    await assert.rejects(held, /Access changed/); assert.equal(client.readStored('revision:P1:paper-build-requests', null), null); assert.deepEqual(client.quarantinedDrafts(), []);
    const next = makeClient(); const heldSession = paperArtifact(next, 'P1', 'PB1', 'pdf', data.length, digest(data), new AbortController().signal); lockSession(); release(new Response(data, { headers: { 'X-Access-Epoch': '1', 'Content-Length': String(data.length) } })); await assert.rejects(heldSession, /session changed/i);
  } finally { globalThis.fetch = original; lockSession(); }
});

test('an artifact denial rechecks normal object access and removes private source snapshots', async () => {
  const original = globalThis.fetch; const client = makeClient(); client.writeStored('revision:P1', { private: 'source' });
  try {
    globalThis.fetch = async path => String(path).includes('/artifacts/') ? new Response('', { status: 404 }) : Response.json({ error: 'Unavailable', code: 'OBJECT_UNAVAILABLE' }, { status: 404 });
    await assert.rejects(paperArtifact(client, 'P1', 'PB1', 'pdf', 1, '0'.repeat(64), new AbortController().signal), /unavailable/i);
    assert.equal(client.unavailableObject('P1'), true); assert.equal(client.readStored('revision:P1', null), null);
  } finally { globalThis.fetch = original; lockSession(); }
});
