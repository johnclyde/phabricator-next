import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { createApp, type AppOptions } from './app.ts';
import { createAuth } from './auth.ts';
import { Store } from './store.ts';
import { registerFilePolicy } from './policy.ts';
import { inspectDocx, replaceDocx } from './docx-package.ts';
import type { SessionState } from '../shared/auth.ts';
import type { RevisionDetail, ReviewComment, ReviewThread } from '../shared/types.ts';
import { docxDiscussionBytes, type DocxDiscussionExport, type DocxDiscussionExportInput } from '../shared/docx-discussion.ts';

const source = await readFile(new URL('../tests/fixtures/docx/roundtrip.docx', import.meta.url));
const projection = await inspectDocx(source);
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const workspace = { kind: 'workspace' as const };
const members = (...principalIds: string[]) => ({ kind: 'principals' as const, principalIds });
const deferred = <T = void>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { resolve, promise }; };
type ErrorBody = { error: string; code?: string };

async function start(options: AppOptions = {}) {
  const store = new Store({ path: ':memory:' });
  const provision = createAuth({ database: store.database, mode: 'local', basePath: '/', provisioning: true });
  const alice = await provision.createAccount({ username: 'alice', displayName: 'Alice Reviewer', password: 'Alice Word discussion password' });
  const bob = await provision.createAccount({ username: 'bob', displayName: 'Bob Reviewer', password: 'Bob Word discussion password' });
  const app = createApp({ ...options, store, seed: false, authMode: 'password' });
  const token = {
    alice: app.auth.createToken(alice.id, { name: 'Alice', scopes: ['read', 'write'] }),
    bob: app.auth.createToken(bob.id, { name: 'Bob', scopes: ['read', 'write'] }),
    reader: app.auth.createToken(bob.id, { name: 'Reader', scopes: ['read'] }),
    writer: app.auth.createToken(bob.id, { name: 'Writer', scopes: ['write'] }),
  };
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const url = (path: string) => origin + (options.basePath ?? '/').replace(/\/$/, '') + path;
  let sequence = 0;
  async function raw(path: string, method = 'GET', input?: unknown, actor: keyof typeof token | null = 'alice', signal?: AbortSignal) {
    return fetch(url(path), { method, signal: signal ?? AbortSignal.timeout(30_000), headers: { ...(actor ? { Authorization: `Bearer ${token[actor].token}` } : {}), ...(input === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
  }
  async function request<T = ErrorBody>(path: string, method = 'GET', input?: unknown, actor: keyof typeof token | null = 'alice') {
    const response = await raw(path, method, input, actor); return { status: response.status, headers: response.headers, body: await response.json() as T };
  }
  const policy = (id: string, changes: Record<string, unknown>) => { const current = app.policies.policy(id, alice.id); return app.policies.setPolicy(id, { expectedVersion: current.version, spaceId: current.spaceId, ...current.rules, ...changes }, alice.id); };
  function document() {
    const actor = { principalId: alice.id, displayName: 'Alice Reviewer', credentialId: token.alice.record.id, requestId: `setup-${++sequence}` };
    const file = store.files.upload({ name: 'Discussion.docx', bytes: source.length, sha256: digest(source), dataBase64: source.toString('base64') }, actor);
    registerFilePolicy(store.database, file.id, alice.id);
    const detail = store.createDocxRevision({ testPlan: 'Fixture verification plan.', title: 'Word discussion', sourceFile: { fileId: file.id, sha256: file.sha256, bytes: file.bytes }, shareSource: true, expectedAccessEpoch: app.policies.epoch() }, source, projection, actor);
    const version = detail.versions[0]!;
    const range = version.docx!.projection.editableRanges.find(item => item.text === 'The original result is clear.')!;
    assert.ok(range); return { detail, version, range, id: detail.revision.id, file };
  }
  async function comment(doc: ReturnType<typeof document>, body = 'Please explain this result.') {
    const input = { body, versionId: doc.version.id, docxPassage: { rangeId: doc.range.id, start: 4, end: 19, quote: doc.range.text.slice(4, 19) } };
    const response = await request<ReviewComment>(`/api/revisions/${doc.id}/comments`, 'POST', input);
    assert.equal(response.status, 201, JSON.stringify(response.body)); return { comment: response.body, input };
  }
  const exportInput = (doc: ReturnType<typeof document>, ...comments: ReviewComment[]): DocxDiscussionExportInput => ({ versionId: doc.version.id, contentHash: doc.version.contentHash, expectedAccessEpoch: app.policies.epoch(), threads: comments.map(item => ({ threadId: item.threadId!, expectedThreadVersion: store.detail(doc.id).threads.find(thread => thread.id === item.threadId)!.version })) });
  let closing: Promise<void> | undefined;
  return { ...app, token, alice, bob, request, raw, url, origin, policy, document, comment, exportInput, close: () => closing ??= (async () => { await app.close(); store.close(); })() };
}

for (const basePath of ['/', '/mounted/']) test(`Word passage discussions export selected full threads without changing source at ${basePath}`, async () => {
  const app = await start({ basePath });
  try {
    const doc = app.document(); const original = JSON.stringify(app.store.detail(doc.id).versions);
    const first = await app.comment(doc), second = await app.comment(doc, 'A separate review thread.');
    assert.equal(first.comment.docxAnchor?.quote, 'original result'); assert.equal(first.comment.filePath, null); assert.equal(first.comment.anchor, undefined);
    const reply = await app.request<ReviewComment>(`/api/revisions/${doc.id}/threads/${first.comment.id}/replies`, 'POST', { body: 'A response with a tab\tand Unicode 📝.', viewedVersionId: doc.version.id }, 'bob');
    assert.equal(reply.status, 201); assert.deepEqual(reply.body.docxAnchor, first.comment.docxAnchor);
    const resolved = await app.request<ReviewThread>(`/api/revisions/${doc.id}/threads/${first.comment.id}`, 'PATCH', { status: 'resolved', expectedThreadVersion: 2, versionId: doc.version.id });
    assert.equal(resolved.status, 200);
    app.policy(doc.id, { edit: members(app.alice.id), interact: members(app.alice.id) });
    const input = app.exportInput(doc, second.comment, first.comment);
    const response = await app.request<DocxDiscussionExport>(`/api/revisions/${doc.id}/docx/export-discussion`, 'POST', input, 'reader');
    assert.equal(response.status, 200, JSON.stringify(response.body)); assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('x-access-epoch'), String(input.expectedAccessEpoch));
    const bytes = await docxDiscussionBytes(response.body, doc.id, input, doc.version);
    const rendered = await inspectDocx(bytes); const added = rendered.comments.filter(item => item.author === 'Alice Reviewer');
    assert.equal(added.length, 2); assert.equal(rendered.comments.length, projection.comments.length + 2);
    assert.ok(added[0]!.blocks.map(block => block.text).join('\n').includes('A separate review thread.'));
    const transcript = added[1]!.blocks.map(block => block.text).join('\n');
    for (const value of ['Status: resolved', first.comment.id, 'Alice Reviewer', 'Bob Reviewer', doc.version.id, 'Please explain', 'A response with a tab', '📝']) assert.ok(transcript.includes(value), value);
    assert.deepEqual(rendered.blocks.map(block => block.text), projection.blocks.map(block => block.text));
    assert.equal(JSON.stringify(app.store.detail(doc.id).versions), original); assert.deepEqual(Buffer.from(app.store.docxBytes(doc.id, doc.version.id)), source);
    assert.equal(app.store.database.prepare('SELECT count(*) AS n FROM file_contents').get()?.n, 1);
    assert.equal((await app.request(`/api/revisions/${doc.id}/docx/export-discussion`, 'POST', input, 'writer')).status, 403);
    assert.equal((await app.request(`/api/revisions/${doc.id}/comments`, 'POST', first.input, 'reader')).status, 403);
  } finally { await app.close(); }
});

test('Word passage validation rejects ambiguous, foreign, note and forged anchors without creating threads', async () => {
  const app = await start();
  try {
    const doc = app.document(), foreign = app.document();
    const good = { body: 'Bound source', versionId: doc.version.id, docxPassage: { rangeId: doc.range.id, start: 0, end: 3, quote: 'The' } };
    const note = projection.editableRanges.find(item => item.part !== projection.mainPart)!; assert.ok(note);
    for (const input of [
      { ...good, filePath: null }, { ...good, line: null }, { ...good, passage: {} }, { ...good, suggestion: {} },
      { ...good, docxPassage: { ...good.docxPassage, quote: 'bad' } }, { ...good, docxPassage: { ...good.docxPassage, end: 0 } },
      { ...good, docxPassage: { ...good.docxPassage, start: 0.5 } }, { ...good, docxPassage: { ...good.docxPassage, rangeId: 'absent' } },
      { ...good, docxPassage: { ...good.docxPassage, author: 'Forged' } },
      { ...good, docxPassage: { rangeId: note.id, start: 0, end: 1, quote: note.text.slice(0, 1) } },
      { ...good, versionId: foreign.version.id },
    ]) assert.equal((await app.request(`/api/revisions/${doc.id}/comments`, 'POST', input)).status, 400);
    assert.equal(app.store.detail(doc.id).comments.length, 0); assert.equal(app.store.detail(doc.id).threads.length, 0);
    const comment = await app.comment(doc);
    assert.equal(comment.comment.docxAnchor?.contentHash, doc.version.contentHash);
  } finally { await app.close(); }
});

test('Word exports select historical original anchors and never borrow newer source or mismatched discussions', async () => {
  const app = await start();
  try {
    const doc = app.document(), foreign = app.document(); const first = await app.comment(doc), other = await app.comment(foreign);
    const actor = { principalId: app.alice.id, displayName: 'Alice Reviewer', credentialId: null, requestId: 'next-version' };
    const updated = app.store.createDocxVersion(doc.id, { sourceFile: { fileId: doc.file.id, sha256: doc.file.sha256, bytes: doc.file.bytes }, shareSource: false, expectedVersion: 1, expectedVersionId: doc.version.id, expectedContentHash: doc.version.contentHash, expectedAccessEpoch: app.policies.epoch(), message: 'Next immutable package' }, source, projection, actor);
    const next = updated.versions.find(item => item.number === 2)!;
    const reply = await app.request<ReviewComment>(`/api/revisions/${doc.id}/threads/${first.comment.id}/replies`, 'POST', { body: 'Read while viewing v2', viewedVersionId: next.id });
    assert.equal(reply.status, 201); assert.equal(reply.body.docxAnchor?.versionId, doc.version.id); assert.equal(reply.body.viewedVersionId, next.id);
    const input = app.exportInput(doc, first.comment), path = `/api/revisions/${doc.id}/docx/export-discussion`;
    const old = await app.request<DocxDiscussionExport>(path, 'POST', input); assert.equal(old.status, 200); assert.equal(old.body.versionNumber, 1);
    assert.equal((await app.request(path, 'POST', { ...input, versionId: next.id, contentHash: next.contentHash })).status, 409);
    assert.equal((await app.request(path, 'POST', { ...input, threads: [{ threadId: other.comment.id, expectedThreadVersion: 1 }] })).status, 404);
    const general = await app.request<ReviewComment>(`/api/revisions/${doc.id}/comments`, 'POST', { body: 'Whole-version discussion', versionId: doc.version.id });
    assert.equal((await app.request(path, 'POST', { ...input, threads: [{ threadId: general.body.id, expectedThreadVersion: 1 }] })).status, 409);
    for (const invalid of [
      { ...input, threads: [] }, { ...input, threads: [...input.threads, ...input.threads] }, { ...input, threads: Array.from({ length: 65 }, (_, index) => ({ threadId: String(index), expectedThreadVersion: 1 })) },
      { ...input, threads: [{ ...input.threads[0]!, extra: true }] }, { ...input, threads: [{ ...input.threads[0]!, expectedThreadVersion: 0 }] },
      { ...input, body: 'Client authored transcript' }, { ...input, expectedAccessEpoch: -1 }, { ...input, contentHash: 'invalid' },
    ]) assert.equal((await app.request(path, 'POST', invalid)).status, 400);
    assert.equal((await app.request(path, 'POST', { ...input, contentHash: '0'.repeat(64) })).status, 409);
    assert.equal((await app.request(path + '?extra=true', 'POST', input)).status, 400);
    assert.equal((await app.request(path, 'POST', input, null)).status, 401);
  } finally { await app.close(); }
});

test('Word export validates current authority before parsing and after worker success or failure', async () => {
  for (const failure of [false, true]) {
    const entered = deferred(), release = deferred(); let calls = 0;
    const app = await start({ docxProcessor: { inspect: inspectDocx, replace: replaceDocx, exportDiscussion: async () => { calls++; entered.resolve(); await release.promise; if (failure) throw new Error('SECRET PACKAGE FAILURE'); return { bytes: source, projection }; } } });
    try {
      const doc = app.document(); const first = await app.comment(doc);
      const space = app.policies.createSpace({ name: 'Document source', view: workspace, edit: members(app.alice.id) }, app.alice.id);
      app.policy(doc.file.id, { spaceId: space.id });
      const input = app.exportInput(doc, first.comment), path = `/api/revisions/${doc.id}/docx/export-discussion`;
      const pending = app.request(path, 'POST', input, 'reader'); await entered.promise;
      app.policies.updateSpace(space.id, { expectedVersion: space.version, view: members(app.alice.id) }, app.alice.id); release.resolve();
      const response = await pending; assert.equal(response.status, 404); assert.equal(JSON.stringify(response.body).includes('SECRET'), false);
      assert.equal((await app.request(path, 'POST', { secret: true }, 'reader')).status, 404); assert.equal(calls, 1);
      assert.equal(app.store.detail(doc.id).versions.length, 1);
    } finally { release.resolve(); await app.close(); }
  }
});

test('Word export rejects concurrent replies, resolution, epoch changes and revoked read credentials', async () => {
  for (const change of ['reply', 'resolve', 'epoch', 'credential'] as const) {
    const entered = deferred(), release = deferred();
    const app = await start({ docxProcessor: { inspect: inspectDocx, replace: replaceDocx, exportDiscussion: async () => { entered.resolve(); await release.promise; return { bytes: source, projection }; } } });
    try {
      const doc = app.document(); const first = await app.comment(doc);
      const input = app.exportInput(doc, first.comment), path = `/api/revisions/${doc.id}/docx/export-discussion`;
      const pending = app.request(path, 'POST', input, 'reader'); await entered.promise;
      if (change === 'reply') app.store.createReply(doc.id, first.comment.id, { body: 'Arrived during export', viewedVersionId: doc.version.id });
      if (change === 'resolve') app.store.updateThread(doc.id, first.comment.id, { status: 'resolved', expectedThreadVersion: 1, versionId: doc.version.id });
      if (change === 'epoch') app.policies.createSpace({ name: 'Unrelated new Space' }, app.alice.id);
      if (change === 'credential') app.auth.revokeToken(app.bob.id, app.token.reader.record.id);
      release.resolve(); const response = await pending;
      assert.equal(response.status, change === 'credential' ? 401 : 409);
      assert.equal(response.body.code, change === 'credential' ? undefined : change === 'epoch' ? 'ACCESS_EPOCH_CHANGED' : 'DOCX_DISCUSSION_CHANGED');
      assert.equal(app.store.detail(doc.id).versions.length, 1);
    } finally { release.resolve(); await app.close(); }
  }
});

test('Word export enforces complete transcript bounds before processing', async () => {
  let calls = 0;
  const app = await start({ docxProcessor: { inspect: inspectDocx, replace: replaceDocx, exportDiscussion: async () => { calls++; return { bytes: source, projection }; } } });
  try {
    const doc = app.document(); const first = await app.comment(doc);
    for (let index = 0; index < 25; index++) app.store.createReply(doc.id, first.comment.id, { body: 'x'.repeat(20_000), viewedVersionId: doc.version.id });
    assert.throws(() => app.store.read(() => app.store.docxDiscussion(doc.id, app.exportInput(doc, first.comment))), /complete selected discussions/);
    const response = await app.request(`/api/revisions/${doc.id}/docx/export-discussion`, 'POST', app.exportInput(doc, first.comment));
    assert.equal(response.status, 413); assert.equal(response.body.code, 'DOCX_DISCUSSION_LIMIT'); assert.equal(calls, 0);
    assert.equal(app.store.detail(doc.id).comments.length, 26, 'no published message is truncated or removed');
  } finally { await app.close(); }
});

test('Word export preserves session CSRF requirements despite being read-scoped', async () => {
  const app = await start();
  try {
    const doc = app.document(); const first = await app.comment(doc), input = app.exportInput(doc, first.comment);
    const bootstrap = await fetch(app.url('/api/session')); const challenge = await bootstrap.json() as SessionState;
    const login = await fetch(app.url('/api/login'), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: app.origin, Cookie: bootstrap.headers.getSetCookie().map(value => value.split(';')[0]!).join('; '), 'X-CSRF-Token': challenge.csrfToken! }, body: JSON.stringify({ username: 'bob', password: 'Bob Word discussion password' }) });
    assert.equal(login.status, 200); const session = await login.json() as SessionState;
    const headers = { 'Content-Type': 'application/json', Origin: app.origin, Cookie: login.headers.getSetCookie().map(value => value.split(';')[0]!).join('; '), 'X-Session-Context': session.sessionContext! };
    const path = app.url(`/api/revisions/${doc.id}/docx/export-discussion`);
    assert.equal((await fetch(path, { method: 'POST', headers, body: JSON.stringify(input) })).status, 403);
    assert.equal((await fetch(path, { method: 'POST', headers: { ...headers, 'X-CSRF-Token': session.csrfToken! }, body: JSON.stringify(input) })).status, 200);
  } finally { await app.close(); }
});

test('Word export cancellation and shutdown await processing and publish no partial result', async () => {
  const entered = deferred(), released = deferred(), canceled = deferred();
  const app = await start({ docxProcessor: { inspect: inspectDocx, replace: replaceDocx, exportDiscussion: async (_bytes, _comments, signal) => {
    signal?.addEventListener('abort', () => canceled.resolve(), { once: true }); entered.resolve(); await released.promise; return { bytes: source, projection };
  } } });
  try {
    const doc = app.document(), first = await app.comment(doc); const controller = new AbortController();
    const pending = app.raw(`/api/revisions/${doc.id}/docx/export-discussion`, 'POST', app.exportInput(doc, first.comment), 'reader', controller.signal).catch(() => undefined);
    await entered.promise; controller.abort(); await canceled.promise;
    let closed = false; const closing = app.close().then(() => { closed = true; });
    await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(closed, false);
    released.resolve(); await closing; await pending; assert.equal(closed, true);
  } finally { released.resolve(); await app.close(); }
});
