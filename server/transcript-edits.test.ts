import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { createApp, type AppOptions } from './app.ts';
import { createAuth } from './auth.ts';
import { Store, contentHash, transcriptEditInputHash } from './store.ts';
import { inspectDocx, replaceDocx } from './docx-package.ts';
import { createPassageAnchor } from '../shared/anchors.ts';
import { parseTranscriptEditInput, transcriptSourceEdit, type TranscriptEditInput } from '../shared/transcript-edit.ts';
import { TRANSCRIPTION_MODEL, TRANSCRIPTION_MODEL_SHA256 } from '../shared/transcription-model.ts';
import type { ActorAttribution, RevisionDetail, RevisionVersion } from '../shared/types.ts';
import type { FileRecord } from '../shared/files.ts';
import type { RevisionLifecycleInput } from '../shared/revision-lifecycle.ts';

const bytes = await readFile(new URL('../tests/fixtures/docx/roundtrip.docx', import.meta.url));
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const head = (detail: RevisionDetail) => detail.versions.find(item => item.number === detail.revision.currentVersion)!;
const members = (...principalIds: string[]) => ({ kind: 'principals' as const, principalIds });
type ErrorBody = { error: string; code?: string };

async function start(options: AppOptions = {}) {
  const store = new Store({ path: ':memory:' });
  const provision = createAuth({ database: store.database, mode: 'local', basePath: '/', provisioning: true });
  const alice = await provision.createAccount({ username: 'alice', displayName: 'Alice Author', password: 'Transcript author strong password' });
  const bob = await provision.createAccount({ username: 'bob', displayName: 'Bob Editor', password: 'Transcript editor strong password' });
  const app = createApp({ ...options, store, seed: false, authMode: 'password' });
  const token = { alice: app.auth.createToken(alice.id, { name: 'Author', scopes: ['read', 'write'] }), retry: app.auth.createToken(alice.id, { name: 'Other author credential', scopes: ['read', 'write'] }), bob: app.auth.createToken(bob.id, { name: 'Editor', scopes: ['read', 'write'] }), reader: app.auth.createToken(alice.id, { name: 'Reader', scopes: ['read'] }) };
  const actor: ActorAttribution = { principalId: alice.id, displayName: alice.displayName, credentialId: token.alice.record.id, requestId: 'fixture' };
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}${(options.basePath ?? '/').replace(/\/$/, '')}`;
  const raw = (path: string, input?: unknown, key?: string, who: keyof typeof token | null = 'alice', signal?: AbortSignal) => fetch(origin + path, { method: input === undefined ? 'GET' : 'POST', signal: signal ?? AbortSignal.timeout(30_000), headers: { ...(who ? { Authorization: `Bearer ${token[who].token}` } : {}), ...(input === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
  const request = async <T = ErrorBody>(path: string, input?: unknown, key?: string, who: keyof typeof token | null = 'alice') => { const response = await raw(path, input, key, who); return { status: response.status, body: await response.json() as T }; };
  const path = (id: string) => `/api/revisions/${id}/transcript-edits`;
  const revision = (kind: 'code' | 'paper' | 'document' = 'paper', content = 'Before this exact passage. After.\n') => store.createRevision({ title: 'Transcript source', testPlan: 'Exact source verification', kind, files: [{ path: 'source.txt', content }, { path: 'untouched.txt', content: 'Unchanged supporting source\r\n' }] }, actor);
  const policy = (id: string, changes: Record<string, unknown>) => { const current = app.policies.policy(id, alice.id); return app.policies.setPolicy(id, { expectedVersion: current.version, spaceId: current.spaceId, ...current.rules, ...changes }, alice.id); };
  const input = (version: RevisionVersion, replacement = 'The edited transcript — exact 🗣️ prose.') => {
    const range = version.docx?.projection.editableRanges.find(item => item.text.trim());
    const target: TranscriptEditInput['target'] = range ? { kind: 'docx', rangeId: range.id, start: 0, end: range.text.length, quote: range.text } : { kind: 'text', anchor: createPassageAnchor(version, version.files[0]!.path, { start: 0, end: Math.min(6, version.files[0]!.content.length), quote: version.files[0]!.content.slice(0, 6) }) };
    return parseTranscriptEditInput({ format: 'phabricator.transcript-edit.v1', revisionId: version.revisionId, expectedVersion: version.number, expectedVersionId: version.id, expectedContentHash: version.contentHash, expectedAccessEpoch: app.policies.epoch(), target, replacement, message: 'Apply reviewed transcript draft', origin: { kind: 'client-local-transcript', clipId: 'clip-123', runId: 'run-456', audioSha256: sha('private audio never sent'), audioBytes: 1024, modelId: TRANSCRIPTION_MODEL.repository, modelRevision: TRANSCRIPTION_MODEL.revision, modelManifestSha256: TRANSCRIPTION_MODEL_SHA256, runtimeVersion: '4.3.1', originalTextSha256: sha('private model original never sent'), editedTextSha256: sha(replacement) } });
  };
  let sequence = 0;
  const upload = async (data: Buffer, name: string) => { const result = await request<FileRecord>('/api/files', { name, bytes: data.length, sha256: sha(data), dataBase64: data.toString('base64') }, `upload-${++sequence}`); assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body; };
  const word = async () => { const file = await upload(bytes, 'Draft.docx'); const result = await request<RevisionDetail>('/api/revisions/docx', { title: 'Word transcript source', testPlan: 'Exact package fixture', sourceFile: { fileId: file.id, sha256: file.sha256, bytes: file.bytes }, shareSource: false, expectedAccessEpoch: app.policies.epoch() }, `word-${++sequence}`); assert.equal(result.status, 201, JSON.stringify(result.body)); return { file, detail: result.body }; };
  return { ...app, token, alice, bob, actor, raw, request, path, revision, policy, input, upload, word, stop: app.close, close: async () => { await app.close(); store.close(); } };
}

for (const basePath of ['/', '/mounted/']) test(`transcript text edits create exact attributed source and fixed receipts at ${basePath}`, async () => {
  let providerCalls = 0;
  const app = await start({ basePath, analyzeAI: async () => { providerCalls++; throw new Error('No implicit provider call'); } });
  try {
    for (const kind of ['code', 'paper', 'document'] as const) {
      const initial = app.revision(kind), original = head(initial), data = app.input(original, '  Literal draft\nwith Unicode 🗣️ and \\LaTeX.  '), path = app.path(initial.revision.id);
      const result = await app.request<RevisionDetail>(path, data, `edit-${kind}`); assert.equal(result.status, 201, JSON.stringify(result.body));
      const next = head(result.body);
      assert.equal(next.files[0]!.content, data.replacement + original.files[0]!.content.slice(6)); assert.deepEqual(next.files[1], original.files[1]);
      assert.equal(next.number, 2); assert.equal(next.contentHash, contentHash(next.files)); assert.notEqual(next.id, original.id);
      assert.deepEqual(result.body.versions[0], original); assert.deepEqual(next.transcriptEdit, transcriptSourceEdit(data, transcriptEditInputHash(data)));
      assert.equal(next.attribution?.principalId, app.alice.id); assert.equal(next.attribution?.displayName, 'Alice Author'); assert.equal(next.message, data.message);
      assert.equal(next.gitSource, undefined); assert.equal(result.body.comments.length, 0); assert.equal(result.body.threads.length, 0); assert.equal(result.body.reviews.length, 0);
      app.store.createVersion(original.revisionId, { expectedVersion: 2, files: [{ path: 'later.txt', content: 'A later independent version' }], message: 'Later source' }, app.actor);
      // JSON field ordering has no bearing on the canonical operation identity.
      const reordered = Object.fromEntries(Object.entries(data).reverse());
      const replay = await app.request<RevisionDetail>(path, reordered, `edit-${kind}`, 'retry'); assert.equal(replay.status, 201); assert.deepEqual(replay.body.versions, result.body.versions); assert.equal(replay.body.revision.currentVersion, 2);
      assert.equal((await app.request(path, data, `stale-${kind}`)).status, 409);
      assert.equal(app.store.detail(original.revisionId).versions.length, 3);
      const changedOrigin = { ...data, origin: { ...data.origin, runId: 'another-run' } }; assert.equal((await app.request(path, changedOrigin, `edit-${kind}`)).status, 409);
    }
    assert.equal(providerCalls, 0);
  } finally { await app.close(); }
});

test('transcript endpoint rejects unpinned, forged, no-op and oversized edits without any writes', async () => {
  const app = await start();
  try {
    const initial = app.revision(), original = head(initial), data = app.input(original), path = app.path(original.revisionId);
    const before = app.store.database.prepare('SELECT COUNT(*) AS n FROM idempotency').get()!.n;
    const bad: unknown[] = [
      { ...data, audio: 'must never be accepted' }, { ...data, originalText: 'private ASR output' }, { ...data, files: original.files }, { ...data, transcriptEdit: {} },
      { ...data, expectedVersion: undefined }, { ...data, expectedVersionId: 'other' }, { ...data, expectedContentHash: 'e'.repeat(64) }, { ...data, expectedAccessEpoch: data.expectedAccessEpoch + 1 },
      { ...data, replacement: '' }, { ...data, replacement: 'x'.repeat(20_001) }, { ...data, replacement: 'Before', origin: { ...data.origin, editedTextSha256: sha('Before') } },
      { ...data, replacement: 'different literal' }, { ...data, replacement: '\ud800' }, { ...data, origin: { ...data.origin, runtimeVersion: 'unknown' } },
      { ...data, target: { kind: 'text', anchor: { ...(data.target.kind === 'text' ? data.target.anchor : {}), prefix: 'forged context' } } },
    ];
    assert.equal((await app.request(path, data)).status, 400);
    for (const [index, value] of bad.entries()) { const response = await app.request(path, value, `bad-${index}`); assert.ok([400, 409].includes(response.status), `${index}: ${JSON.stringify(response)}`); }
    const foreign = app.revision(); assert.equal((await app.request(app.path(foreign.revision.id), data, 'foreign')).status, 400);
    assert.deepEqual(app.store.detail(original.revisionId), initial);
    assert.equal(app.store.database.prepare('SELECT COUNT(*) AS n FROM idempotency').get()!.n, before);
    const huge = app.revision('code', 'a'.repeat(500_000)), oversized = app.input(head(huge), 'b'.repeat(20_000));
    assert.equal((await app.request(app.path(huge.revision.id), oversized, 'full-snapshot-limit')).status, 400); assert.equal(app.store.detail(huge.revision.id).versions.length, 1);
  } finally { await app.close(); }
});

test('transcript edits preserve figures and invalidate old exact-source acceptance', async () => {
  const app = await start();
  try {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
    const file = await app.upload(png, 'figure.png');
    const asset = { path: 'figure.png', fileId: file.id, sha256: file.sha256, bytes: file.bytes, mediaType: file.mediaType };
    const detail = app.store.createRevision({ title: 'Paper with exact figure', testPlan: 'Verify figure', kind: 'paper', files: [{ path: 'paper.tex', content: 'Before manuscript prose' }], assets: [asset], shareAssets: true }, app.actor), id = detail.revision.id;
    app.store.saveReview(id, 1, { provider: 'local', model: 'deterministic fixture', summary: 'No findings', findings: [] }, app.actor);
    const snapshot = app.store.revisionLifecycle.snapshot(id, app.alice.id);
    const accept: RevisionLifecycleInput = { action: 'accept_reviewed', expectedLifecycleVersion: snapshot.lifecycle.version, expectedReviewerVersion: snapshot.reviewers.version, expectedAuthorVersion: snapshot.authorship.version, expectedVersion: 1, expectedVersionId: head(detail).id, expectedContentHash: head(detail).contentHash, expectedAccessEpoch: app.policies.epoch(), expectedConfigId: snapshot.configId, expectedEvidenceSha256: snapshot.evidence.sha256, message: 'Accept original exact evidence' };
    assert.equal((await app.request(`/api/revisions/${id}/lifecycle`, accept, 'accept')).status, 200);
    const result = await app.request<RevisionDetail>(app.path(id), app.input(head(detail)), 'figure-edit'); assert.equal(result.status, 201, JSON.stringify(result.body));
    assert.deepEqual(head(result.body).assets, [asset]); assert.deepEqual(Buffer.from(app.store.files.readBytes(file.id)), png); assert.equal(result.body.revision.status, 'needs_review');
    const after = app.store.revisionLifecycle.snapshot(id, app.alice.id); assert.equal(after.reviewers.acceptance, null); assert.equal(result.body.reviews[0]!.versionId, head(detail).id);
    assert.equal(app.store.database.prepare('SELECT COUNT(*) AS n FROM file_contents').get()!.n, 1);
  } finally { await app.close(); }
});

test('transcript writes and retries enforce current account, edit and historical source authority', async () => {
  const app = await start();
  try {
    const detail = app.revision(), data = app.input(head(detail)), path = app.path(detail.revision.id);
    assert.equal((await app.request(path, data, 'unsigned', null)).status, 401); assert.equal((await app.request(path, data, 'read-only', 'reader')).status, 403);
    app.policy(detail.revision.id, { edit: members(app.alice.id) }); data.expectedAccessEpoch = app.policies.epoch();
    assert.equal((await app.request(path, data, 'no-edit', 'bob')).status, 403);
    app.policy(detail.revision.id, { edit: members(app.bob.id) }); data.expectedAccessEpoch = app.policies.epoch();
    assert.equal((await app.request(path, data, 'saved', 'bob')).status, 201);
    app.policy(detail.revision.id, { edit: members(app.alice.id) }); assert.equal((await app.request(path, data, 'saved', 'bob')).status, 403);
    assert.equal(app.store.detail(detail.revision.id).versions.length, 2);
    const word = await app.word(); app.policy(word.file.id, { view: { kind: 'workspace' } });
    const wordData = app.input(head(word.detail)), wordPath = app.path(word.detail.revision.id);
    assert.equal((await app.request(wordPath, wordData, 'word-saved', 'bob')).status, 201);
    app.policy(word.file.id, { view: members(app.alice.id) });
    assert.equal((await app.request(wordPath, wordData, 'word-saved', 'bob')).status, 404);
    assert.equal(app.store.detail(word.detail.revision.id).versions.length, 2);
    app.auth.revokeToken(app.alice.id, app.token.retry.record.id);
    assert.equal((await app.request(path, data, 'saved', 'retry')).status, 401);
  } finally { await app.close(); }
});

test('real Word transcript replacement retains package provenance and exports tracked changes', async () => {
  const app = await start();
  try {
    const { detail } = await app.word(), original = head(detail), data = app.input(original), path = app.path(original.revisionId);
    const result = await app.request<RevisionDetail>(path, data, 'word-edit'); assert.equal(result.status, 201, JSON.stringify(result.body));
    const next = head(result.body); assert.ok(next.docx); assert.deepEqual(next.files, []); assert.deepEqual(result.body.versions[0], original);
    assert.deepEqual(next.docx.sourceFile, original.docx!.sourceFile); assert.notEqual(next.docx.sha256, original.docx!.sha256); assert.equal(next.contentHash, contentHash([], [], next.docx));
    assert.deepEqual(next.transcriptEdit, transcriptSourceEdit(data, transcriptEditInputHash(data)));
    const changes = next.docx.projection.changes.filter(change => change.author === 'Alice Author'); assert.ok(changes.some(change => change.text === data.replacement));
    const download = await app.raw(`/api/revisions/${original.revisionId}/docx/${next.id}/download`); assert.equal(download.status, 200);
    const packageBytes = new Uint8Array(await download.arrayBuffer()); assert.equal(sha(packageBytes), next.docx.sha256); assert.deepEqual(await inspectDocx(packageBytes), next.docx.projection);
    assert.deepEqual(Buffer.from(app.store.docxBytes(original.revisionId, original.id)), bytes); assert.equal(result.body.comments.length, 0); assert.equal(result.body.reviews.length, 0);
    const replay = await app.request<RevisionDetail>(path, data, 'word-edit', 'retry'); assert.equal(replay.status, 201); assert.deepEqual(replay.body.versions, result.body.versions);
    const nextInput = app.input(next); assert.equal((await app.request(path, { ...nextInput, replacement: 'multiple\nlines', origin: { ...nextInput.origin, editedTextSha256: sha('multiple\nlines') } }, 'word-multiline')).status, 400);
    assert.equal((await app.request(path, { ...nextInput, target: { kind: 'docx', rangeId: 'unsupported', start: 0, end: 1, quote: 'x' } }, 'word-range')).status, 409);
    assert.equal(app.store.detail(original.revisionId).versions.length, 2);
  } finally { await app.close(); }
});

test('pending Word transcript preparation rechecks revoked source before commit and cancels without a receipt', async () => {
  let entered!: () => void, release!: () => void;
  const starting = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const app = await start({ docxProcessor: { inspect: inspectDocx, replace: async (source, replacement, attribution, signal) => { const result = await replaceDocx(source, replacement, attribution, signal); entered(); await gate; return result; } } });
  try {
    const { detail, file } = await app.word(); app.policy(file.id, { view: { kind: 'workspace' } }); const data = app.input(head(detail));
    const pending = app.request(app.path(detail.revision.id), data, 'revoked-preparation', 'bob'); await starting;
    app.policy(file.id, { view: members(app.alice.id) }); release();
    const response = await pending; assert.equal(response.status, 404); assert.equal(app.store.detail(detail.revision.id).versions.length, 1);
    assert.equal(app.store.database.prepare("SELECT COUNT(*) AS n FROM idempotency WHERE key LIKE '%:revoked-preparation'").get()!.n, 0);
    assert.equal(app.store.database.prepare('SELECT COUNT(*) AS n FROM revision_docx_packages').get()!.n, 1);
  } finally { release(); await app.close(); }
});

test('concurrent transcript requests serialize exact heads and same-key retries create only one version', async () => {
  const app = await start();
  try {
    const initial = app.revision(), data = app.input(head(initial)), path = app.path(initial.revision.id);
    const same = await Promise.all([app.request<RevisionDetail>(path, data, 'same'), app.request<RevisionDetail>(path, data, 'same', 'retry')]);
    assert.deepEqual(same.map(result => result.status), [201, 201]); assert.deepEqual(same[0]!.body.versions, same[1]!.body.versions);
    const next = app.input(head(same[0]!.body), 'The next exact replacement.');
    const competing = await Promise.all(['a', 'b'].map(key => app.request(path, next, key))); assert.deepEqual(competing.map(result => result.status).sort(), [201, 409]);
    assert.equal(app.store.detail(initial.revision.id).versions.length, 3);
  } finally { await app.close(); }
});

test('an old canonical receipt cannot be substituted for another transcript origin even without response bindings', async () => {
  const app = await start();
  try {
    const initial = app.revision(), data = app.input(head(initial)), path = app.path(initial.revision.id);
    assert.equal((await app.request(path, data, 'bound-origin')).status, 201);
    const receipt = app.store.database.prepare("SELECT key,fingerprint,body FROM idempotency WHERE key LIKE '%:bound-origin'").get() as { key: string; fingerprint: string; body: string };
    app.store.database.exec('DROP TRIGGER revision_project_response_bindings_no_delete');
    app.store.database.prepare('DELETE FROM revision_project_response_bindings WHERE key_sha256=?').run(sha(receipt.key));
    const different = parseTranscriptEditInput({ ...data, origin: { ...data.origin, runId: 'another-client-run' } });
    app.store.database.prepare('UPDATE idempotency SET fingerprint=? WHERE key=?').run(sha(JSON.stringify(['POST', path, different])), receipt.key);
    const response = await app.request(path, different, 'bound-origin', 'retry'); assert.equal(response.status, 409); assert.equal(response.body.code, 'TRANSCRIPT_RECEIPT_MISMATCH');
    assert.equal(app.store.detail(initial.revision.id).versions.length, 2); assert.equal(app.store.database.prepare('SELECT body FROM idempotency WHERE key=?').get(receipt.key)!.body, receipt.body);
    app.store.database.prepare('UPDATE idempotency SET fingerprint=? WHERE key=?').run(receipt.fingerprint, receipt.key); assert.equal((await app.request(path, data, 'bound-origin')).status, 201);
  } finally { await app.close(); }
});

for (const boundary of ['head', 'epoch', 'account', 'disconnect'] as const) test(`pending Word transcript edits retire at the ${boundary} boundary`, async () => {
  let entered!: () => void, release!: () => void, aborted!: () => void;
  const starting = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; }), canceled = new Promise<void>(resolve => { aborted = resolve; });
  const app = await start({ docxProcessor: { inspect: inspectDocx, replace: async (source, replacement, attribution, signal) => {
    signal?.addEventListener('abort', aborted, { once: true });
    const result = await replaceDocx(source, replacement, attribution, signal); entered(); await gate; return result;
  } } });
  try {
    const { detail } = await app.word(), original = head(detail), data = app.input(original), controller = new AbortController();
    const pending = app.raw(app.path(original.revisionId), data, `late-${boundary}`, 'alice', controller.signal).catch(error => error as Error); await starting;
    if (boundary === 'head') app.store.createDocxVersion(original.revisionId, { expectedVersion: original.number, expectedVersionId: original.id, expectedContentHash: original.contentHash, expectedAccessEpoch: app.policies.epoch(), sourceFile: original.docx!.sourceFile, shareSource: false, message: 'Concurrent reimport with identical content hash' }, bytes, original.docx!.projection, app.actor);
    if (boundary === 'epoch') { const other = app.revision(); app.policy(other.revision.id, { edit: members(app.alice.id) }); }
    if (boundary === 'account') app.auth.setAccountDisabled(app.alice.id, true);
    if (boundary === 'disconnect') {
      controller.abort();
      await new Promise<void>((resolve, reject) => { const timeout = setTimeout(() => reject(new Error('The disconnected request did not cancel Word processing.')), 5000); void canceled.then(() => { clearTimeout(timeout); resolve(); }); });
    }
    release(); const response = await pending;
    if (boundary === 'disconnect') assert.ok(response instanceof Error);
    else { assert.ok(response instanceof Response); assert.equal(response.status, boundary === 'account' ? 401 : 409, JSON.stringify(await response.json())); }
    // close waits for disconnected processing and its final writer-lock guard.
    await app.stop();
    const versions = app.store.detail(original.revisionId).versions;
    assert.equal(versions.length, boundary === 'head' ? 2 : 1); assert.ok(versions.every(version => version.transcriptEdit === undefined));
    assert.equal(app.store.database.prepare('SELECT COUNT(*) AS n FROM idempotency WHERE key LIKE ?').get(`%:late-${boundary}`)!.n, 0);
  } finally { release(); await app.close(); }
});

test('a failed transcript receipt transaction rolls back the source, provenance, lifecycle and activity together', async () => {
  const app = await start();
  try {
    const initial = app.revision(), data = app.input(head(initial)), id = initial.revision.id;
    const before = app.store.revisionLifecycle.snapshot(id, app.alice.id);
    app.store.database.exec("CREATE TEMP TRIGGER reject_transcript_receipt BEFORE INSERT ON idempotency WHEN NEW.key LIKE '%:rollback-transcript' BEGIN SELECT RAISE(ABORT, 'deliberate receipt failure'); END");
    assert.equal((await app.request(app.path(id), data, 'rollback-transcript')).status, 500);
    assert.deepEqual(app.store.detail(id), initial); assert.deepEqual(app.store.revisionLifecycle.snapshot(id, app.alice.id), before);
    assert.equal(app.store.database.prepare("SELECT COUNT(*) AS n FROM idempotency WHERE key LIKE '%:rollback-transcript'").get()!.n, 0);
    app.store.database.exec('DROP TRIGGER reject_transcript_receipt');
    const retry = await app.request<RevisionDetail>(app.path(id), data, 'rollback-transcript'); assert.equal(retry.status, 201); assert.equal(retry.body.versions.length, 2); assert.ok(head(retry.body).transcriptEdit);
  } finally { await app.close(); }
});

test('transcript edits rehash the entire original source rather than trusting its stored digest or selected quote', async () => {
  const app = await start();
  try {
    const initial = app.revision(), original = head(initial), data = app.input(original);
    // A damaged unrelated file must fail even while the selected quote/context
    // and the cached source digest still appear to match the proposed edit.
    app.store.database.prepare("UPDATE versions SET data=json_set(data,'$.files[1].content','damaged unrelated source') WHERE id=?").run(original.id);
    const response = await app.request(app.path(initial.revision.id), data, 'damaged-source');
    assert.equal(response.status, 409); assert.equal(response.body.code, 'TRANSCRIPT_SOURCE_CHANGED');
    assert.equal(app.store.detail(initial.revision.id).versions.length, 1);
    assert.equal(app.store.database.prepare("SELECT COUNT(*) AS n FROM idempotency WHERE key LIKE '%:damaged-source'").get()!.n, 0);
  } finally { await app.close(); }
});
