import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { assetChanges, assetManifest, digestBytes, fileBytes, sameAssets, uploadBody, uploadIntent, uploadMatches } from '../client/file-client.ts';
import { canQueue, createWorkspaceClient } from '../client/offline.ts';
import { activateSession, lockSession } from '../client/session.ts';
import { normalizeVersionDraft, versionDraftChanged } from '../client/VersionEditor.tsx';
import type { FileRecord, RevisionAsset } from '../shared/files.ts';
import type { ObjectAccess } from '../shared/policy.ts';
import type { RevisionVersion } from '../shared/types.ts';

const rights: ObjectAccess = { policy: { objectId: 'F1', version: 1, spaceId: 'S1', rules: { view: { kind: 'workspace' }, edit: { kind: 'workspace' }, interact: { kind: 'workspace' } } }, capabilities: { view: true, edit: true, interact: true, managePolicy: true }, viewLabel: 'Workspace', editLabel: 'Workspace', interactLabel: 'Workspace' };
function client() { const value = createWorkspaceClient(activateSession({ mode: 'password', workspaceId: 'files', account: { id: 'alice', username: 'alice', displayName: 'Alice', disabled: false }, sessionContext: 'alice-session', csrfToken: 'csrf', expiresAt: null })); value.reconcileAccess({ F1: rights, P1: rights, R1: rights }, 1); return value; }
const asset: RevisionAsset = { path: 'figures/a.png', fileId: 'F1', sha256: 'a'.repeat(64), bytes: 45, mediaType: 'image/png' };
const version: RevisionVersion = { id: 'version-one', revisionId: 'P1', number: 1, contentHash: 'b'.repeat(64), files: [{ path: 'main.tex', content: 'Original source' }], assets: [asset], message: 'Initial', createdAt: '2026-01-01' };

test('upload recovery is source-free and exact reselected bytes are mandatory', async () => {
  const bytes = new TextEncoder().encode('the original upload'), digest = await digestBytes(bytes);
  const intent = { id: 'f657dedd-908b-46f9-8d42-e58f9dfe0a16', name: 'figure.png', altText: 'Original description', sha256: digest, bytes: bytes.length, createdAt: '2026-01-01' };
  assert.deepEqual(uploadIntent({ ...intent, dataBase64: 'must disappear', url: 'private', file: bytes }), intent);
  assert.equal(uploadIntent({ ...intent, bytes: 100_000_000 }), null);
  assert.equal(uploadIntent({ ...intent, sha256: 'wrong' }), null);
  assert.equal(uploadIntent({ ...intent, bytes: 0 })?.bytes, 0);
  const empty = { ...intent, bytes: 0, sha256: await digestBytes(new Uint8Array()) };
  assert.equal((await uploadBody(empty, new Uint8Array())).dataBase64, '');
  assert.equal((await uploadBody(intent, bytes)).dataBase64, Buffer.from(bytes).toString('base64'));
  await assert.rejects(uploadBody(intent, new TextEncoder().encode('the different bytes')), /original file/);
  assert.equal(uploadMatches({ id: 'F1', bytes: intent.bytes, sha256: digest, originalName: intent.name } as FileRecord, intent), true);
  assert.equal(uploadMatches({ id: 'F1', bytes: intent.bytes, sha256: digest, originalName: 'other.png' } as FileRecord, intent), false);
});

test('legacy text drafts inherit their exact base figures; explicit empty manifest means removal', () => {
  const old = { files: version.files, message: '' };
  assert.equal(versionDraftChanged(old, version), false);
  const migrated = normalizeVersionDraft(old, version); assert.deepEqual(migrated.assets, [asset]); assert.deepEqual(migrated.base, { id: version.id, contentHash: version.contentHash, number: 1 });
  assert.deepEqual(normalizeVersionDraft({ ...old, assets: [] }, version).assets, []); assert.equal(versionDraftChanged({ ...old, assets: [] }, version), true);
  assert.equal(sameAssets([asset], [{ ...asset, fileId: 'F2' }]), false);
  assert.deepEqual(assetChanges([asset], [{ ...asset, sha256: 'c'.repeat(64) }]).map(item => item.kind), ['Replaced']);
  assert.deepEqual(assetManifest([{ ...asset, surprise: 'not retained' } as RevisionAsset]), [asset]);
  assert.equal(canQueue('/api/revisions/P1/versions', 'POST', { expectedVersion: 1, files: version.files }), true);
  assert.equal(canQueue('/api/revisions/P1/versions', 'POST', { expectedVersion: 1, files: version.files, assets: [] }), false);
  for (const path of ['/api/files', '/api/files/F1', '/api/files/F1/attachments']) assert.equal(canQueue(path, 'POST', {}), false);
});

test('private binary download verifies session, byte bounds, hash and headers', async () => {
  const previous = globalThis.fetch, value = client(), data = new TextEncoder().encode('file bytes'), sha256 = createHash('sha256').update(data).digest('hex');
  const file = { id: 'F1', bytes: data.length, sha256 }, headers = { 'Content-Length': String(data.length), 'X-Content-SHA256': sha256, 'X-Access-Epoch': '1' };
  try {
    globalThis.fetch = async (_url, options) => { assert.equal(options?.redirect, 'error'); assert.equal(options?.cache, 'no-store'); assert.deepEqual(options?.headers, { 'X-Session-Context': 'alice-session' }); return new Response(data, { headers }); };
    assert.deepEqual(await fileBytes(value, file, new AbortController().signal), data);
    const emptyHash = await digestBytes(new Uint8Array());
    globalThis.fetch = async () => new Response(new Uint8Array(), { headers: { ...headers, 'Content-Length': '0', 'X-Content-SHA256': emptyHash } });
    assert.deepEqual(await fileBytes(value, { id: 'F1', bytes: 0, sha256: emptyHash }, new AbortController().signal), new Uint8Array());
    globalThis.fetch = async () => new Response(new Uint8Array(data.length + 1), { headers });
    await assert.rejects(fileBytes(value, file, new AbortController().signal), /exceeded/);
    globalThis.fetch = async () => new Response(new Uint8Array(data.length), { headers });
    await assert.rejects(fileBytes(value, file, new AbortController().signal), /integrity/);
    globalThis.fetch = async () => new Response(data, { headers: { ...headers, 'X-Content-SHA256': 'c'.repeat(64) } });
    await assert.rejects(fileBytes(value, file, new AbortController().signal), /metadata/);
    assert.equal([...value.session!.memory.values()].some(row => row.includes('file bytes')), false);
  } finally { globalThis.fetch = previous; lockSession(); }
});

test('historical figure revocation retires cached revisions, pending reads and preserves draft exports', async () => {
  const previous = globalThis.fetch, value = client();
  try {
    value.writeStored('revision:P1', { revision: { id: 'P1', repositoryId: 'R1' }, versions: [version, { ...version, id: 'second', number: 2, assets: [] }] });
    value.writeStored('version-draft:P1:2', { files: version.files, assets: [asset], message: 'Unsaved figure change' });
    assert.deepEqual([...(value.session!.revisionFiles.get('P1') || [])], ['F1']);
    let release!: (response: Response) => void;
    globalThis.fetch = () => new Promise(resolve => { release = resolve; });
    const request = fileBytes(value, { id: 'F1', bytes: 1, sha256: 'a'.repeat(64) }, new AbortController().signal);
    value.reconcileAccess({ P1: rights, R1: rights }, 2);
    release(new Response(new Uint8Array([1]), { headers: { 'Content-Length': '1', 'X-Content-SHA256': 'a'.repeat(64), 'X-Access-Epoch': '1' } }));
    await assert.rejects(request, /access changed/i);
    assert.equal(value.readStored('revision:P1', null), null);
    assert.equal(value.readStored('version-draft:P1:2', null), null);
    assert.equal(value.quarantinedDrafts().some(item => item.key === 'version-draft:P1:2'), true);
    assert.equal(value.writeStored('revision:P1', { private: 'must not revive' }), false);
  } finally { globalThis.fetch = previous; lockSession(); }
});

test('a denied binary response invokes ordinary file revocation for dependent source', async () => {
  const previous = globalThis.fetch, value = client();
  try { value.writeStored('revision:P1', { revision: { id: 'P1' }, versions: [version] });
    globalThis.fetch = async path => String(path).endsWith('/data') ? new Response('', { status: 404 }) : new Response(JSON.stringify({ code: 'OBJECT_UNAVAILABLE', error: 'Unavailable' }), { status: 404 });
    await assert.rejects(fileBytes(value, { id: 'F1', bytes: 1, sha256: 'a'.repeat(64) }, new AbortController().signal)); assert.equal(value.unavailableObject('F1'), true); assert.equal(value.unavailableObject('P1'), true);
  } finally { globalThis.fetch = previous; lockSession(); }
});
