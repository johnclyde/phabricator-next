import test from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_PAPER_FORMAT, DEVICE_PAPER_LIMITS, parseDevicePaperImport, serializeDevicePaper, validateDevicePaper, validateDevicePaperSource } from '../shared/device-papers';
import { createDevicePaperStore, devicePaperDatabaseName, DevicePaperStorageError, newDevicePaper, paperStorageEstimate, requestPersistentPaperStorage } from '../client/device-papers';

test('device exports retain exact source and import only portable source into a fresh identity', () => {
  const source = { title: 'A mathematical paper 😀', files: [{ path: 'main.tex', content: '\\documentclass{article}\r\n\\input{sections/proof}\r\n' }, { path: 'sections/proof.tex', content: 'a\r\nb\rc\n\\(\\alpha + 😀\\)\n' }] };
  const paper = newDevicePaper(source.title, source.files), exportText = serializeDevicePaper(paper), exported = JSON.parse(exportText);
  assert.deepEqual(Object.keys(exported), ['format', 'title', 'files']); assert.equal(exported.format, DEVICE_PAPER_FORMAT);
  const imported = parseDevicePaperImport({ ...exported, id: paper.id, revision: 999, workspaceId: 'foreign', csrfToken: 'secret' });
  assert.deepEqual(imported, source); const second = newDevicePaper(imported.title, imported.files);
  assert.notEqual(second.id, paper.id); assert.equal(second.revision, 0);
  imported.files[0]!.content = 'changed'; assert.equal(source.files[0]!.content, paper.files[0]!.content);
});

test('device paper text validation rejects collisions, traversal, malformed text and oversized imports', () => {
  const source = (files: unknown) => ({ title: 'Paper', files });
  for (const path of ['../main.tex', '/main.tex', 'a\\b.tex', 'a:b.tex', './main.tex', 'a//b.tex', 'a/../b.tex', 'a\0.tex', 'x'.repeat(241)]) assert.throws(() => validateDevicePaperSource(source([{ path, content: '' }])), /path/i, path);
  for (const paths of [['a.tex', 'A.tex'], ['é.tex', 'e\u0301.tex'], ['a', 'a/b.tex']]) assert.throws(() => validateDevicePaperSource(source(paths.map(path => ({ path, content: '' })))), /path|directory|collide|unique/i);
  for (const content of ['bad\0text', '\ud800', '\udc00', 'x'.repeat(DEVICE_PAPER_LIMITS.fileBytes + 1), 'é'.repeat(DEVICE_PAPER_LIMITS.fileBytes / 2 + 1)]) assert.throws(() => validateDevicePaperSource(source([{ path: 'main.tex', content }])));
  for (const files of [[], Array.from({ length: DEVICE_PAPER_LIMITS.files + 1 }, (_, i) => ({ path: `${i}.tex`, content: '' })), Array.from({ length: 6 }, (_, i) => ({ path: `${i}.tex`, content: 'x'.repeat(DEVICE_PAPER_LIMITS.fileBytes) }))]) assert.throws(() => validateDevicePaperSource(source(files)));
  for (const title of ['', ' ', 'x'.repeat(201), 'bad\nline', '\ud800']) assert.throws(() => validateDevicePaperSource({ title, files: [{ path: 'main.tex', content: '' }] }));
  assert.throws(() => parseDevicePaperImport({ format: 'future', title: 'Paper', files: [] }), /supported/);
  assert.throws(() => parseDevicePaperImport(null), /supported/);
});

test('saved records need valid revision and times but temporary drafts remain source-only copies', () => {
  const temporary = newDevicePaper(); assert.equal(temporary.revision, 0); assert.equal(temporary.title, 'Untitled paper');
  assert.throws(() => validateDevicePaper(temporary), /revision/);
  assert.deepEqual(validateDevicePaper(temporary, true), temporary);
  const saved = { ...temporary, revision: 1 }; assert.deepEqual(validateDevicePaper(saved), saved);
  for (const patch of [{ revision: -1 }, { revision: 0.5 }, { revision: Infinity }, { id: '' }, { createdAt: 'today' }, { updatedAt: '2000-01-01T00:00:00.000Z' }]) assert.throws(() => validateDevicePaper({ ...saved, ...patch }));
});

test('standalone device storage separates mounts and unavailable storage has no memory fallback', async () => {
  assert.equal(devicePaperDatabaseName('/'), 'phabricator-next:device-papers');
  assert.equal(devicePaperDatabaseName('/papers'), 'phabricator-next:mount:%2Fpapers%2F:device-papers');
  let attempts = 0;
  const store = createDevicePaperStore({ indexedDB: { open: () => { attempts++; throw new DOMException('Denied', 'SecurityError'); } } as unknown as IDBFactory });
  await assert.rejects(store.save(newDevicePaper(), null), cause => cause instanceof DevicePaperStorageError && cause.code === 'unavailable');
  await assert.rejects(store.list(), DevicePaperStorageError); assert.equal(attempts, 2);
  store.close(); await assert.rejects(store.read('draft'), cause => cause instanceof DevicePaperStorageError && cause.code === 'closed');
  assert.deepEqual(await requestPersistentPaperStorage(), { persisted: false }); assert.equal(await paperStorageEstimate(), null);
});

test('blocked database opening reports failure promptly and closes a late successful connection', async () => {
  const request = {} as IDBOpenDBRequest; let closed = false;
  const store = createDevicePaperStore({ indexedDB: { open: () => request } as unknown as IDBFactory });
  const pending = store.list(); request.onblocked!(new Event('blocked') as IDBVersionChangeEvent);
  await assert.rejects(pending, cause => cause instanceof DevicePaperStorageError && cause.code === 'blocked');
  Object.defineProperty(request, 'result', { value: { close: () => { closed = true; } } }); request.onsuccess!(new Event('success'));
  assert.equal(closed, true); store.close();
});
