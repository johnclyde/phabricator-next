import { aiProposalHead, type AIProposalDetail } from '../shared/ai-proposals.ts';
import { docxResolutionInputCanonical, type DocxResolveInput, type DocxResolutionDetail } from '../shared/docx-resolution.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { createApp, type AppOptions } from './app.ts';
import { createAuth } from './auth.ts';
import { Store } from './store.ts';
import { inspectDocx, replaceDocx, replaceDocxBatch, inspectDocxResolution, resolveDocxChanges } from './docx-package.ts';
import { docxBatchParagraphs, docxBatchInputCanonical, type DocxReplaceBatchInput } from '../shared/docx-batch.ts';
import type { FileRecord } from '../shared/files.ts';
import type { DocxImportInput, DocxInspection, DocxReplaceInput } from '../shared/docx.ts';
import type { RevisionDetail } from '../shared/types.ts';

const bytes = await readFile(new URL('../tests/fixtures/docx/roundtrip.docx', import.meta.url));
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const workspace = { kind: 'workspace' as const };
const members = (...principalIds: string[]) => ({ kind: 'principals' as const, principalIds });
const head = (detail: RevisionDetail) => detail.versions.find(item => item.number === detail.revision.currentVersion)!;
type ErrorBody = { error: string; code?: string };

async function start(options: AppOptions = {}) {
  const store = new Store({ path: ':memory:' });
  const provision = createAuth({ database: store.database, mode: 'local', basePath: '/', provisioning: true });
  const alice = await provision.createAccount({ username: 'alice', displayName: 'Alice Reviewer', password: 'A strong document account password' });
  const bob = await provision.createAccount({ username: 'bob', displayName: 'Bob Reviewer', password: 'Another document account password' });
  const app = createApp({ ...options, store, seed: false, authMode: 'password' });
  const token = {
    alice: app.auth.createToken(alice.id, { name: 'Alice', scopes: ['read', 'write', 'review:local', 'review:hosted'] }),
    aliceOther: app.auth.createToken(alice.id, { name: 'Alice retry', scopes: ['read', 'write', 'review:local'] }),
    bob: app.auth.createToken(bob.id, { name: 'Bob', scopes: ['read', 'write'] }),
    reader: app.auth.createToken(alice.id, { name: 'Reader', scopes: ['read'] }),
  };
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  let sequence = 0;
  async function raw(path: string, method = 'GET', input?: unknown, actor: keyof typeof token | null = 'alice', key?: string) {
    return fetch(origin + path, { method, signal: AbortSignal.timeout(30_000), headers: { ...(actor ? { Authorization: `Bearer ${token[actor].token}` } : {}), ...(input === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
  }
  async function request<T = ErrorBody>(path: string, method = 'GET', input?: unknown, actor: keyof typeof token | null = 'alice', key?: string) {
    const response = await raw(path, method, input, actor, key); return { status: response.status, headers: response.headers, body: await response.json() as T };
  }
  const policy = (id: string, changes: Record<string, unknown>) => { const current = app.policies.policy(id, alice.id); return app.policies.setPolicy(id, { expectedVersion: current.version, spaceId: current.spaceId, ...current.rules, ...changes }, alice.id); };
  async function upload(data = bytes) {
    const response = await request<FileRecord>('/api/files', 'POST', { name: 'Motion.docx', bytes: data.length, sha256: digest(data), dataBase64: data.toString('base64') }, 'alice', `upload-${++sequence}`);
    assert.equal(response.status, 201, JSON.stringify(response.body)); return response.body;
  }
  async function importDocument(file: FileRecord, shareSource = false, key = `import-${++sequence}`) {
    const input: DocxImportInput = { testPlan: 'Fixture verification plan.', title: 'Motion draft', sourceFile: { fileId: file.id, sha256: file.sha256, bytes: file.bytes }, shareSource, expectedAccessEpoch: app.policies.epoch() };
    const response = await request<RevisionDetail>('/api/revisions/docx', 'POST', input, 'alice', key);
    assert.equal(response.status, 201, JSON.stringify(response.body)); return { detail: response.body, input, key };
  }
  function replacement(detail: RevisionDetail): DocxReplaceInput {
    const version = head(detail), range = version.docx!.projection.editableRanges.find(item => item.text.trim())!;
    assert.ok(range, 'golden document must contain an editable run');
    return { expectedVersion: version.number, expectedVersionId: version.id, expectedContentHash: version.contentHash, expectedAccessEpoch: app.policies.epoch(), rangeId: range.id, start: 0, end: range.text.length, quote: range.text, replacement: 'An authenticated revision.', message: 'Clarified the motion' };
  }
  let closing: Promise<void> | undefined;
  return { ...app, token, alice, bob, request, raw, upload, importDocument, policy, replacement, close: () => closing ??= (async () => { await app.close(); store.close(); })() };
}

test('Word API imports exact packages privately, honors current source policies and keeps original downloads byte-identical', async () => {
  const app = await start();
  try {
    const file = await app.upload(); const inspected = await app.request<DocxInspection>(`/api/files/${file.id}/docx`);
    assert.equal(inspected.status, 200); assert.equal(inspected.body.sourceFile.sha256, file.sha256);
    assert.ok(inspected.body.projection.notes.length); assert.ok(inspected.body.projection.comments.length); assert.ok(inspected.body.projection.changes.length);
    assert.equal((await app.request(`/api/files/${file.id}/docx`, 'GET', undefined, 'bob')).status, 404);
    const { detail, input, key } = await app.importDocument(file); const version = head(detail), id = detail.revision.id;
    assert.equal(detail.revision.kind, 'document'); assert.deepEqual(version.files, []); assert.equal(version.docx?.sha256, file.sha256);
    assert.equal(app.store.files.attachment(file.id, id), null);
    assert.equal((await app.request(`/api/revisions/${id}`, 'GET', undefined, 'bob')).status, 404);
    const path = `/api/revisions/${id}/docx/${version.id}/download`; const download = await app.raw(path);
    assert.equal(download.status, 200); assert.equal(download.headers.get('x-content-sha256'), file.sha256); assert.equal(download.headers.get('x-revision-version-id'), version.id);
    assert.equal(download.headers.get('cache-control'), 'private, no-store'); assert.equal(download.headers.get('x-content-type-options'), 'nosniff'); assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
    assert.deepEqual((await app.request<RevisionDetail>('/api/revisions/docx', 'POST', input, 'aliceOther', key)).body, detail);
    assert.equal((await app.request('/api/revisions/docx', 'POST', input, null, key)).status, 401);
    assert.equal((await app.request('/api/revisions/docx', 'POST', input, 'reader', key)).status, 403);
    assert.equal((await app.request('/api/revisions/docx', 'POST', input, 'alice')).status, 400);
    app.policy(file.id, { view: workspace });
    assert.equal((await app.request(`/api/revisions/${id}`, 'GET', undefined, 'bob')).status, 200);
    app.policy(file.id, { view: members(app.alice.id) });
    assert.equal((await app.request(path, 'GET', undefined, 'bob')).status, 404);
    const unknown = await app.request(`/api/revisions/${id}/docx/unknown/download`); assert.equal(unknown.status, 404); assert.equal(unknown.body.code, 'DOCX_VERSION_UNAVAILABLE');
  } finally { await app.close(); }
});

test('Word API writes tracked replacements, retains exact receipts and source dependencies through export/reimport', async () => {
  const app = await start();
  try {
    const file = await app.upload(); const initial = await app.importDocument(file, true); const id = initial.detail.revision.id, original = head(initial.detail);
    assert.equal((await app.request(`/api/revisions/${id}`, 'GET', undefined, 'bob')).status, 200);
    const input = app.replacement(initial.detail); const path = `/api/revisions/${id}/docx/replace`;
    const changed = await app.request<RevisionDetail>(path, 'POST', input, 'alice', 'tracked-edit'); assert.equal(changed.status, 201, JSON.stringify(changed.body));
    const edited = head(changed.body); assert.equal(edited.number, 2); assert.notEqual(edited.contentHash, original.contentHash); assert.equal(edited.attribution?.principalId, app.alice.id);
    assert.deepEqual(edited.docx?.sourceFile, original.docx?.sourceFile); assert.ok(edited.docx?.projection.changes.some(item => item.author === 'Alice Reviewer'));
    assert.equal(app.store.database.prepare('SELECT COUNT(*) AS n FROM file_contents').get()?.n, 1, 'generated package has no independent File download path');
    assert.deepEqual((await app.request<RevisionDetail>(path, 'POST', input, 'aliceOther', 'tracked-edit')).body, changed.body);
    assert.equal((await app.request(path, 'POST', { ...input, replacement: 'Different retry' }, 'alice', 'tracked-edit')).status, 409);
    assert.equal((await app.request(path, 'POST', input, 'alice', 'stale-head')).status, 409);
    const exported = await app.raw(`/api/revisions/${id}/docx/${edited.id}/download`); const exportedBytes = Buffer.from(await exported.arrayBuffer()); assert.equal(digest(exportedBytes), edited.docx?.sha256);
    const nextFile = await app.upload(exportedBytes); const next = { sourceFile: { fileId: nextFile.id, sha256: nextFile.sha256, bytes: nextFile.bytes }, shareSource: true, expectedVersion: 2, expectedVersionId: edited.id, expectedContentHash: edited.contentHash, expectedAccessEpoch: app.policies.epoch(), message: 'Reimported exact export' };
    const reimported = await app.request<RevisionDetail>(`/api/revisions/${id}/docx/import`, 'POST', next, 'alice', 'reimport'); assert.equal(reimported.status, 201, JSON.stringify(reimported.body)); assert.equal(head(reimported.body).number, 3);
    assert.deepEqual(head(reimported.body).docx?.projection, edited.docx?.projection);
    assert.equal((await app.request<RevisionDetail>(path, 'POST', input, 'aliceOther', 'tracked-edit')).body.revision.currentVersion, 2, 'historical receipt never selects a newer version');
    const attachment = app.store.files.attachment(file.id, id)!;
    const detach = await app.request(`/api/files/${file.id}/attachments`, 'POST', { objectId: id, mode: 'detach', expectedVersion: attachment.version }, 'alice', 'detach'); assert.equal(detach.status, 200);
    assert.equal((await app.request(`/api/revisions/${id}`, 'GET', undefined, 'bob')).status, 404, 'all historical original Files continue to restrict the document');
    assert.equal((await app.request(`/api/revisions/${id}/docx/${head(reimported.body).id}/download`, 'GET', undefined, 'bob')).status, 404);
  } finally { await app.close(); }
});

test('Word API rejects format-confused writes and empty automated review without contacting a provider', async () => {
  let providerCalls = 0; const app = await start({ analyzeAI: async () => { providerCalls++; throw new Error('must not call'); }, aiConfiguration: () => ({ configured: true, model: 'test' }) });
  try {
    const file = await app.upload(); const { detail, input } = await app.importDocument(file); const id = detail.revision.id, version = head(detail);
    assert.equal((await app.request('/api/revisions/docx', 'POST', { ...input, projection: {} }, 'alice', 'client-projection')).status, 400);
    assert.equal((await app.request(`/api/revisions/${id}/versions`, 'POST', { expectedVersion: 1, files: [{ path: 'flattened.md', content: 'lossy' }], message: 'Wrong format' }, 'alice', 'text')).status, 409);
    for (const provider of ['local', 'openai']) { const response = await app.request(`/api/revisions/${id}/reviews`, 'POST', { expectedVersion: 1, provider }, 'alice', `review-${provider}`); assert.equal(response.status, 409); assert.equal(response.body.code, 'DOCX_REVIEW_UNSUPPORTED'); }
    assert.equal(providerCalls, 0); assert.equal(app.store.detail(id).reviews.length, 0);
    assert.equal((await app.request(`/api/revisions/${id}/citations?version=1`)).body.code, 'DOCX_CITATIONS_UNSUPPORTED');
    const replacement = app.replacement(detail); const noOp = await app.request<RevisionDetail>(`/api/revisions/${id}/docx/replace`, 'POST', { ...replacement, replacement: replacement.quote }, 'alice', 'noop');
    assert.equal(noOp.status, 201, JSON.stringify(noOp.body)); assert.equal(head(noOp.body).id, version.id); assert.equal(app.store.detail(id).versions.length, 1);
    assert.equal((await app.request(`/api/revisions/${id}/docx/replace`, 'POST', { ...replacement, quote: 'forged' }, 'alice', 'bad-quote')).status >= 400, true);
    assert.equal(app.store.detail(id).versions.length, 1);
  } finally { await app.close(); }
});

test('Word API revalidates source authority after asynchronous inspection before committing or disclosing results', async () => {
  let notify!: () => void, release!: () => void; const entered = new Promise<void>(resolve => { notify = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  let held = false;
  const app = await start({ docxProcessor: { inspect: async (source, signal) => { const result = await inspectDocx(source, signal); if (held) { notify(); await gate; } return result; }, replace: replaceDocx } });
  try {
    const file = await app.upload(); app.policy(file.id, { view: workspace });
    held = true;
    const input: DocxImportInput = { testPlan: 'Fixture verification plan.', title: 'Bob reading draft', sourceFile: { fileId: file.id, sha256: file.sha256, bytes: file.bytes }, shareSource: false, expectedAccessEpoch: app.policies.epoch() };
    const pending = app.request('/api/revisions/docx', 'POST', input, 'bob', 'revoked-import'); await entered;
    app.policy(file.id, { view: members(app.alice.id) }); release();
    const response = await pending; assert.equal(response.status, 404); assert.equal(response.body.code, 'DOCX_SOURCE_UNAVAILABLE');
    assert.equal(app.store.database.prepare("SELECT COUNT(*) AS n FROM entities WHERE kind='revision'").get()?.n, 0);
    assert.equal(app.store.database.prepare('SELECT COUNT(*) AS n FROM revision_docx_packages').get()?.n, 0);
  } finally { release(); await app.close(); }
});

test('Word API rejects a canonical receipt substituted for a different exact replacement', async () => {
  for (const legacyUnbound of [false, true]) {
    const app = await start();
    try {
      const file = await app.upload(); const { detail } = await app.importDocument(file); const id = detail.revision.id;
      const input = app.replacement(detail), path = `/api/revisions/${id}/docx/replace`;
      const saved = await app.request<RevisionDetail>(path, 'POST', input, 'alice', 'original-replacement'); assert.equal(saved.status, 201);
      const original = app.store.database.prepare("SELECT key,fingerprint,body FROM idempotency WHERE key LIKE '%:original-replacement'").get() as { key: string; fingerprint: string; body: string };
      if (legacyUnbound) {
        // Simulate a pre-schema30 receipt: migration intentionally does not
        // backfill response bindings, so Word's original proof must still work.
        app.store.database.exec('DROP TRIGGER revision_project_response_bindings_no_delete');
        app.store.database.prepare('DELETE FROM revision_project_response_bindings WHERE key_sha256=?').run(createHash('sha256').update(original.key).digest('hex'));
      }
      const different = { ...input, replacement: 'A different proposed argument.' };
      const fingerprint = createHash('sha256').update(JSON.stringify(['POST', path, different])).digest('hex');
      app.store.database.prepare('UPDATE idempotency SET fingerprint=? WHERE key=?').run(fingerprint, original.key);
      const replay = await app.request(path, 'POST', different, 'aliceOther', 'original-replacement');
      assert.equal(replay.status, 409); assert.equal(replay.body.code, legacyUnbound ? 'DOCX_RECEIPT_MISMATCH' : 'REVISION_PROJECT_INVALID_RECEIPT');
      assert.equal(app.store.detail(id).versions.length, 2); assert.equal(app.store.database.prepare('SELECT body FROM idempotency WHERE key=?').get(original.key)!.body, original.body);
      app.store.database.prepare('UPDATE idempotency SET fingerprint=? WHERE key=?').run(original.fingerprint, original.key);
      const recovered = await app.request<RevisionDetail>(path, 'POST', input, 'aliceOther', 'original-replacement');
      assert.equal(recovered.status, 201); assert.deepEqual(recovered.body.versions, saved.body.versions); assert.equal(app.store.detail(id).versions.length, 2);
    } finally { await app.close(); }
  }
});

test('application close awaits disconnected Word processing and its final authority checks', async () => {
  let entered!: () => void, release!: () => void, canceled!: () => void;
  const starting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const aborted = new Promise<void>(resolve => { canceled = resolve; });
  const app = await start({ docxProcessor: { inspect: async (_source, signal) => {
    entered(); signal?.addEventListener('abort', canceled, { once: true });
    if (signal?.aborted) canceled(); await gate; throw new Error('deliberately ended during shutdown');
  }, replace: replaceDocx } });
  try {
    const file = await app.upload();
    const address = app.server.address() as AddressInfo, controller = new AbortController();
    const pending = fetch(`http://127.0.0.1:${address.port}/api/files/${file.id}/docx`, { signal: controller.signal, headers: { Authorization: `Bearer ${app.token.alice.token}` } }).catch(() => undefined);
    await starting; controller.abort(); await aborted;
    let closed = false; const closing = app.close().then(() => { closed = true; });
    await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(closed, false, 'shutdown must retain the Store until processing settles');
    release(); await closing; await pending; assert.equal(closed, true);
  } finally { release(); await app.close(); }
});

test('Word resolution accepts and rejects exact changes, keeps historical receipts, and makes the next editing round possible', async () => {
  for (const action of ['accept', 'reject'] as const) {
    const app = await start();
    try {
      const file = await app.upload(), initial = await app.importDocument(file), id = initial.detail.revision.id, original = head(initial.detail);
      const edit = app.replacement(initial.detail), saved = await app.request<RevisionDetail>(`/api/revisions/${id}/docx/replace`, 'POST', edit, 'alice', 'edit');
      assert.equal(saved.status, 201); const edited = head(saved.body);
      const inspection = await app.request<DocxResolutionDetail>(`/api/revisions/${id}/docx/${edited.id}/changes`);
      assert.equal(inspection.status, 200, JSON.stringify(inspection.body)); assert.equal(inspection.body.versionId, edited.id); assert.equal(inspection.body.contentHash, edited.contentHash); assert.equal(inspection.body.packageHash, edited.docx!.sha256);
      const decisions = inspection.body.inspection.changes.filter(change => change.author === 'Alice Reviewer').map(change => ({ changeId: change.changeId, action })); assert.equal(decisions.length, 2);
      const input: DocxResolveInput = { expectedVersion: edited.number, expectedVersionId: edited.id, expectedContentHash: edited.contentHash, expectedAccessEpoch: app.policies.epoch(), decisions, message: `Explicitly ${action} the tracked edit` }, path = `/api/revisions/${id}/docx/resolve`;
      assert.equal((await app.request(path, 'POST', input, 'reader', 'readonly')).status, 403);
      assert.equal((await app.request(path, 'POST', { ...input, decisions: [...decisions, decisions[0]] }, 'alice', 'duplicate')).status, 400);
      assert.equal((await app.request(path, 'POST', { ...input, decisions: [...decisions, { changeId: 'unknown', action }] }, 'alice', 'unknown')).status >= 400, true);
      assert.equal(app.store.detail(id).versions.length, 2, 'invalid final decisions cannot partially resolve changes');
      const resolved = await app.request<RevisionDetail>(path, 'POST', input, 'alice', 'resolve'); assert.equal(resolved.status, 201, JSON.stringify(resolved.body)); const settled = head(resolved.body);
      assert.equal(settled.number, 3); assert.equal(settled.docxOperation?.kind, 'resolve'); assert.equal(settled.docxOperation.inputSha256, createHash('sha256').update(docxResolutionInputCanonical(input)).digest('hex'));
      assert.equal(settled.docx!.projection.changes.length, original.docx!.projection.changes.length); assert.deepEqual(settled.docx!.sourceFile, original.docx!.sourceFile);
      const nextRange = settled.docx!.projection.editableRanges.find(range => range.text === (action === 'accept' ? edit.replacement : edit.quote)); assert.ok(nextRange, 'settled text is available to the next editing round');
      assert.deepEqual(Buffer.from(app.store.docxBytes(id, original.id)), bytes); assert.deepEqual(resolved.body.versions.slice(0, 2), saved.body.versions);
      const next = { ...edit, expectedVersion: settled.number, expectedVersionId: settled.id, expectedContentHash: settled.contentHash, expectedAccessEpoch: app.policies.epoch(), rangeId: nextRange.id, start: 0, end: nextRange.text.length, quote: nextRange.text, replacement: 'A second review round.' };
      const nextSaved = await app.request<RevisionDetail>(`/api/revisions/${id}/docx/replace`, 'POST', next, 'alice', 'next-round'); assert.equal(nextSaved.status, 201, JSON.stringify(nextSaved.body)); assert.equal(head(nextSaved.body).number, 4);
      const retry = await app.request<RevisionDetail>(path, 'POST', input, 'aliceOther', 'resolve'); assert.equal(retry.status, 201); assert.deepEqual(retry.body, resolved.body); assert.equal(app.store.detail(id).versions.length, 4);
      assert.equal((await app.request(path, 'POST', input, 'alice', 'stale-new-request')).status, 409);
      assert.equal((await app.request(path, 'POST', { ...input, decisions: decisions.map(item => ({ ...item, action: action === 'accept' ? 'reject' : 'accept' })) }, 'alice', 'resolve')).status, 409);
    } finally { await app.close(); }
  }
});

test('Word change inspection rechecks source access before returning a delayed private projection', async () => {
  let entered!: () => void, release!: () => void; const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const app = await start({ docxProcessor: { inspect: inspectDocx, replace: replaceDocx, inspectResolution: async (source, signal) => { const result = await inspectDocxResolution(source, signal); entered(); await gate; return result; } } });
  try {
    const file = await app.upload(); app.policy(file.id, { view: workspace });
    const { detail } = await app.importDocument(file, false), id = detail.revision.id, version = head(detail);
    const pending = app.request(`/api/revisions/${id}/docx/${version.id}/changes`, 'GET', undefined, 'bob'); await started;
    app.policy(file.id, { view: members(app.alice.id) }); release(); const result = await pending; assert.equal(result.status, 404); assert.equal('inspection' in result.body, false); assert.equal(app.store.detail(id).versions.length, 1);
  } finally { release(); await app.close(); }
});

test('Word resolution discards prepared bytes after a concurrent source update and preserves the original selection', async () => {
  let entered!: () => void, release!: () => void; const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const app = await start({ docxProcessor: { inspect: inspectDocx, replace: replaceDocx, resolve: async (source, decisions, signal) => { const result = await resolveDocxChanges(source, decisions, signal); entered(); await gate; return result; } } });
  try {
    const file = await app.upload(), { detail } = await app.importDocument(file), id = detail.revision.id, version = head(detail);
    const inspection = await app.request<DocxResolutionDetail>(`/api/revisions/${id}/docx/${version.id}/changes`); assert.equal(inspection.status, 200); assert.ok(inspection.body.inspection.changes.length);
    const input: DocxResolveInput = { expectedVersion: version.number, expectedVersionId: version.id, expectedContentHash: version.contentHash, expectedAccessEpoch: app.policies.epoch(), decisions: inspection.body.inspection.changes.map(change => ({ changeId: change.changeId, action: 'accept' })), message: 'Resolve old changes' };
    const pending = app.request(`/api/revisions/${id}/docx/resolve`, 'POST', input, 'alice', 'raced-resolution'); await started;
    const concurrent = await app.request<RevisionDetail>(`/api/revisions/${id}/docx/replace`, 'POST', app.replacement(detail), 'alice', 'concurrent'); assert.equal(concurrent.status, 201);
    release(); const result = await pending; assert.equal(result.status, 409); assert.equal(app.store.detail(id).versions.length, 2); assert.deepEqual(Buffer.from(app.store.docxBytes(id, version.id)), bytes);
    assert.equal(app.store.database.prepare("SELECT COUNT(*) AS n FROM idempotency WHERE key LIKE '%:raced-resolution'").get()?.n, 0);
  } finally { release(); await app.close(); }
});

test('Word AI HTTP proposals submit paragraph text and apply one tracked package with private exact historical recovery', async () => {
  let generated = 0, processed = 0;
  const app = await start({ aiConfiguration: () => ({ configured: true, model: 'fixture-model', localConfigured: false, localModel: null }),
    aiProposalProvider: async (_input, source) => { generated++; const file = source.files[0]!; assert.match(file.path, /^docx\/paragraph-/); assert.ok(source.files.every(item => item.path.startsWith('docx/paragraph-'))); return { result: { summary: 'Clarify the selected paragraph.', limitations: 'Synthetic fixture, not model evaluation.', edits: [{ filePath: file.path, start: 0, end: file.content.length, quote: file.content, replacement: 'A proposed clarification.', explanation: 'Requested clarification.' }] }, responseModel: 'fixture-model', providerResponseId: 'word-fixture' }; },
    docxProcessor: { inspect: inspectDocx, replace: replaceDocx, replaceBatch: async (...args) => { processed++; return replaceDocxBatch(...args); } } });
  try {
    const file = await app.upload(), { detail } = await app.importDocument(file), id = detail.revision.id, version = head(detail), path = `/api/revisions/${id}/ai-proposals`;
    const generation = { provider: 'openai', model: 'fixture-model', instruction: 'Clarify one paragraph.', expectedHead: aiProposalHead(version), expectedAccessEpoch: app.policies.epoch(), scope: null, allowHosted: true };
    const proposed = await app.request<AIProposalDetail>(path, 'POST', generation, 'alice', 'word-proposal'); assert.equal(proposed.status, 200, JSON.stringify(proposed.body)); assert.equal(proposed.body.proposal.status, 'ready'); assert.equal(generated, 1); assert.equal(processed, 0);
    const applyPath = `${path}/${proposed.body.proposal.id}/apply`, application = { expectedHead: aiProposalHead(version), expectedAccessEpoch: app.policies.epoch(), expectedProposalSha256: proposed.body.proposal.proposalSha256 };
    const applied = await app.request<AIProposalDetail>(applyPath, 'POST', application, 'alice', 'word-apply'); assert.equal(applied.status, 200, JSON.stringify(applied.body)); assert.equal(applied.body.proposal.applied?.toVersion, 2); assert.equal(processed, 1);
    const updated = app.store.detail(id); assert.equal(head(updated).docxOperation?.kind, 'replace-batch'); assert.deepEqual(head(updated).docx!.sourceFile, version.docx!.sourceFile); assert.deepEqual(updated.versions[0], version); assert.ok(head(updated).docx!.projection.changes.some(change => change.text === 'A proposed clarification.'));
    assert.deepEqual((await app.request<AIProposalDetail>(applyPath, 'POST', application, 'aliceOther', 'word-apply')).body, applied.body); assert.equal(processed, 1);
    assert.equal((await app.request(applyPath, 'POST', application, 'reader', 'word-apply')).status, 403);
    assert.equal((await app.request(`${path}/${proposed.body.proposal.id}`, 'GET', undefined, 'bob')).status, 404);
    assert.equal((await app.request(path, 'POST', generation, 'alice', 'word-proposal')).status, 200); assert.equal(generated, 1); assert.equal(app.store.detail(id).versions.length, 2);
  } finally { await app.close(); }
});

function batchInput(detail: RevisionDetail, epoch: number): DocxReplaceBatchInput {
  const version = head(detail), paragraphs = docxBatchParagraphs(version.docx!.projection).slice(0, 2); assert.equal(paragraphs.length, 2);
  return { expectedVersion: version.number, expectedVersionId: version.id, expectedContentHash: version.contentHash, expectedAccessEpoch: epoch,
    replacements: paragraphs.map((block, index) => ({ blockId: block.id, start: 0, end: block.text.length, quote: block.text, replacement: `Reviewed passage ${index + 1}.` })), message: 'Reviewed the complete Word edit set' };
}
test('Word batch API validates all original passages and records one exact historical operation receipt', async () => {
  const app = await start();
  try {
    const file = await app.upload(), { detail } = await app.importDocument(file), id = detail.revision.id, original = head(detail), path = `/api/revisions/${id}/docx/replace-batch`, input = batchInput(detail, app.policies.epoch());
    for (const [suffix, replacements] of [ ['bad-final', [input.replacements[0]!, { ...input.replacements[1]!, quote: 'x'.repeat(input.replacements[1]!.quote.length) }]], ['overlap', [input.replacements[0]!, input.replacements[0]!]], ['noop', [input.replacements[0]!, { ...input.replacements[1]!, replacement: input.replacements[1]!.quote }]] ] as const) {
      const rejected = await app.request(path, 'POST', { ...input, replacements }, 'alice', suffix); assert.ok(rejected.status >= 400, JSON.stringify(rejected.body)); assert.equal(app.store.detail(id).versions.length, 1); assert.deepEqual(Buffer.from(app.store.docxBytes(id, original.id)), bytes);
    }
    const saved = await app.request<RevisionDetail>(path, 'POST', input, 'alice', 'batch-success'); assert.equal(saved.status, 201, JSON.stringify(saved.body)); assert.equal(saved.body.versions.length, 2);
    const changed = head(saved.body); assert.equal(changed.docxOperation?.kind, 'replace-batch'); assert.equal(changed.docxOperation?.inputSha256, createHash('sha256').update(docxBatchInputCanonical(input)).digest('hex'));
    assert.equal(changed.docx!.projection.changes.filter(change => change.author === 'Alice Reviewer' && change.kind === 'ins').length, 2);
    assert.equal((await app.request(path, 'POST', input, 'alice', 'stale-batch')).status, 409);
    assert.equal((await app.request(path, 'POST', { ...input, replacements: [...input.replacements].reverse() }, 'alice', 'batch-success')).status, 409);
    const exported = await app.raw(`/api/revisions/${id}/docx/${changed.id}/download`), data = Buffer.from(await exported.arrayBuffer()); assert.equal(digest(data), changed.docx!.sha256);
    const nextFile = await app.upload(data), next = await app.request<RevisionDetail>(`/api/revisions/${id}/docx/import`, 'POST', { expectedVersion: changed.number, expectedVersionId: changed.id, expectedContentHash: changed.contentHash, expectedAccessEpoch: app.policies.epoch(), sourceFile: { fileId: nextFile.id, sha256: nextFile.sha256, bytes: nextFile.bytes }, shareSource: false, message: 'Later import' }, 'alice', 'later-import'); assert.equal(next.status, 201, JSON.stringify(next.body));
    const recovered = await app.request<RevisionDetail>(path, 'POST', input, 'aliceOther', 'batch-success'); assert.equal(recovered.status, 201, JSON.stringify(recovered.body)); assert.equal(recovered.body.revision.currentVersion, 2); assert.deepEqual(recovered.body.versions, saved.body.versions); assert.equal(app.store.detail(id).versions.length, 3);
  } finally { await app.close(); }
});

test('Word batch API refuses source and version changes after asynchronous package processing', async () => {
  for (const change of ['source-access', 'head'] as const) {
    let entered!: () => void, release!: () => void; const starting = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const app = await start({ docxProcessor: { inspect: inspectDocx, replace: replaceDocx, replaceBatch: async (source, edits, actor, signal) => { const result = await replaceDocxBatch(source, edits, actor, signal); entered(); await gate; return result; } } });
    try {
      const file = await app.upload(); app.policy(file.id, { view: workspace }); const { detail } = await app.importDocument(file), id = detail.revision.id, input = batchInput(detail, app.policies.epoch()), path = `/api/revisions/${id}/docx/replace-batch`;
      const pending = app.request(path, 'POST', input, 'bob', `inflight-${change}`); await starting;
      if (change === 'source-access') app.policy(file.id, { view: members(app.alice.id) });
      else { const result = await app.request<RevisionDetail>(`/api/revisions/${id}/docx/replace`, 'POST', app.replacement(detail), 'alice', 'concurrent-head'); assert.equal(result.status, 201, JSON.stringify(result.body)); }
      release(); const response = await pending; assert.equal(response.status, change === 'source-access' ? 404 : 409, JSON.stringify(response.body));
      assert.equal(app.store.detail(id).versions.length, change === 'source-access' ? 1 : 2); assert.equal(app.store.database.prepare("SELECT COUNT(*) AS n FROM idempotency WHERE key LIKE ?").get(`%:inflight-${change}`)?.n, 0);
    } finally { release(); await app.close(); }
  }
});
